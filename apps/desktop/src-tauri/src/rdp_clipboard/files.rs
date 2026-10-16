//! Files on the RDP clipboard. Neither side copies data up front: the clipboard carries a list
//! of file descriptors (`FileGroupDescriptorW`), and the side pasting asks for each file's size
//! and contents in ranges with `FileContentsRequest`.
//!
//! - [`Outgoing`]: files copied on this computer, served to the remote when it pastes them.
//! - [`Download`]: files copied on the remote, saved into a local folder chosen by the user.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use ironrdp::cliprdr::pdu::{
    ClipboardFileAttributes, FileContentsFlags, FileContentsRequest, FileContentsResponse,
    FileDescriptor, PackedFileList,
};

/// More files than this in one copy are left out (whole drives copied by mistake).
const MAX_FILES: usize = 20_000;
/// Windows paths in a file descriptor are limited to 260 characters, terminator included.
const MAX_NAME: usize = 259;
/// Largest range served in one response.
const MAX_RANGE: u32 = 16 * 1024 * 1024;
/// Range asked for in each request while downloading.
pub const CHUNK: u32 = 256 * 1024;
/// Progress notices are sent at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// Seconds between 1601-01-01 (Windows FILETIME) and 1970-01-01.
const FILETIME_UNIX_OFFSET: u64 = 11_644_473_600;

fn filetime(time: SystemTime) -> Option<u64> {
    let since_unix = time.duration_since(UNIX_EPOCH).ok()?;
    Some(
        (since_unix.as_secs() + FILETIME_UNIX_OFFSET) * 10_000_000
            + u64::from(since_unix.subsec_nanos() / 100),
    )
}

fn system_time(filetime: u64) -> Option<SystemTime> {
    let since_unix = (filetime / 10_000_000).checked_sub(FILETIME_UNIX_OFFSET)?;
    Some(
        UNIX_EPOCH
            + Duration::from_secs(since_unix)
            + Duration::from_nanos((filetime % 10_000_000) * 100),
    )
}

/// Files copied locally, as offered to the remote: entry `i` answers requests for index `i`.
#[derive(Debug, Default)]
pub struct Outgoing {
    entries: Vec<(PathBuf, bool)>,
}

impl Outgoing {
    /// Lists the copied files and folders (folders recursively, without following links to
    /// other folders) with names relative to the copied items, the way Explorer pastes them.
    pub fn collect(roots: &[PathBuf]) -> (Self, PackedFileList) {
        let mut outgoing = Self::default();
        let mut files = Vec::new();
        for root in roots {
            let Some(name) = root.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            outgoing.add(root, name.to_string(), &mut files);
        }
        (outgoing, PackedFileList { files })
    }

    fn add(&mut self, path: &Path, name: String, files: &mut Vec<FileDescriptor>) {
        if self.entries.len() >= MAX_FILES || name.encode_utf16().count() > MAX_NAME {
            return;
        }
        let Ok(link) = std::fs::symlink_metadata(path) else {
            return;
        };
        let is_dir = link.is_dir();
        // A link is copied as what it points to, except links to folders (they can loop).
        let Ok(metadata) = (if link.is_symlink() {
            std::fs::metadata(path)
        } else {
            Ok(link)
        }) else {
            return;
        };
        if metadata.is_dir() && !is_dir {
            return;
        }
        let attributes = if is_dir {
            ClipboardFileAttributes::DIRECTORY
        } else if metadata.permissions().readonly() {
            ClipboardFileAttributes::READONLY
        } else {
            ClipboardFileAttributes::ARCHIVE
        };
        files.push(FileDescriptor {
            attributes: Some(attributes),
            last_write_time: metadata.modified().ok().and_then(filetime),
            file_size: Some(if is_dir { 0 } else { metadata.len() }),
            name: name.clone(),
        });
        self.entries.push((path.to_path_buf(), is_dir));

        if is_dir && let Ok(children) = std::fs::read_dir(path) {
            let mut children: Vec<_> = children.flatten().collect();
            children.sort_by_key(|child| child.file_name());
            for child in children {
                if let Some(child_name) = child.file_name().to_str() {
                    self.add(&child.path(), format!("{name}\\{child_name}"), files);
                }
            }
        }
    }

    /// Answers the remote asking for a file's size or a range of its contents.
    pub fn respond(&self, request: &FileContentsRequest) -> FileContentsResponse<'static> {
        let stream_id = request.stream_id;
        let Some((path, is_dir)) = self.entries.get(request.index as usize) else {
            return FileContentsResponse::new_error(stream_id);
        };
        let result = if request.flags.contains(FileContentsFlags::SIZE) {
            let size = if *is_dir {
                Ok(0)
            } else {
                std::fs::metadata(path).map(|metadata| metadata.len())
            };
            size.map(|size| FileContentsResponse::new_size_response(stream_id, size))
        } else {
            read_range(
                path,
                request.position,
                request.requested_size.min(MAX_RANGE),
            )
            .map(|data| FileContentsResponse::new_data_response(stream_id, data))
        };
        result.unwrap_or_else(|_| FileContentsResponse::new_error(stream_id))
    }
}

fn read_range(path: &Path, position: u64, size: u32) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(position))?;
    let mut data = Vec::with_capacity(size as usize);
    file.take(u64::from(size)).read_to_end(&mut data)?;
    Ok(data)
}

/// A remote file name (`folder\sub\file.txt`) as a path under the destination folder, or `None`
/// for names that would escape it.
fn relative_path(name: &str) -> Option<PathBuf> {
    let mut path = PathBuf::new();
    for part in name.split(['\\', '/']) {
        if part.is_empty() || part == "." || part == ".." || part.contains([':', '\0']) {
            return None;
        }
        path.push(part);
    }
    let is_plain = path
        .components()
        .all(|component| matches!(component, Component::Normal(_)));
    (is_plain && path.components().next().is_some()).then_some(path)
}

/// `name`, or `name (2)`, `name (3)`… for the first one not taken in `dir`.
fn unique_name(dir: &Path, name: &str, is_dir: bool) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !is_dir && !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    (2..)
        .map(|n| format!("{stem} ({n}){extension}"))
        .find(|candidate| !dir.join(candidate).exists())
        .expect("some name is free")
}

#[derive(Debug)]
struct Entry {
    path: PathBuf,
    is_dir: bool,
    size: Option<u64>,
    modified: Option<SystemTime>,
}

/// What a download needs next.
#[derive(Debug)]
pub enum Step {
    /// Send this request to the server.
    Request(FileContentsRequest),
    /// Everything was saved.
    Done,
}

/// Remote files being saved into a local folder, one range request at a time.
#[derive(Debug)]
pub struct Download {
    entries: Vec<Entry>,
    /// Index of the entry being downloaded.
    current: usize,
    file: Option<File>,
    position: u64,
    stream_id: u32,
    pub done_bytes: u64,
    pub total_bytes: u64,
    /// The copied items as saved (top-level files and folders), to show them when done.
    pub saved: Vec<PathBuf>,
    last_progress: Option<Instant>,
}

impl Download {
    /// Prepares the download of the remote file list into `dir` (created if missing) and
    /// returns the first request to send.
    pub fn start(dir: &Path, files: &[FileDescriptor], stream_id: u32) -> Result<(Self, Step)> {
        std::fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
        // Items copied together keep their names, renamed only when something is in the way.
        let mut renamed: HashMap<std::ffi::OsString, String> = HashMap::new();
        let mut entries = Vec::new();
        let mut saved = Vec::new();
        for file in files {
            let Some(relative) = relative_path(&file.name) else {
                bail!("the remote sent an invalid file name: {}", file.name);
            };
            let is_dir = file
                .attributes
                .is_some_and(|attributes| attributes.contains(ClipboardFileAttributes::DIRECTORY));
            let mut components = relative.components();
            let top = components
                .next()
                .expect("not empty")
                .as_os_str()
                .to_os_string();
            let top_name = renamed.entry(top.clone()).or_insert_with(|| {
                let name = unique_name(
                    dir,
                    &top.to_string_lossy(),
                    is_dir || relative.components().count() > 1,
                );
                saved.push(dir.join(&name));
                name
            });
            let mut path = dir.join(&*top_name);
            if components.as_path().components().next().is_some() {
                path.push(components.as_path());
            }
            entries.push(Entry {
                path,
                is_dir,
                size: if is_dir { Some(0) } else { file.file_size },
                modified: file.last_write_time.and_then(system_time),
            });
        }
        let total_bytes = entries.iter().filter_map(|entry| entry.size).sum();
        let mut download = Self {
            entries,
            current: 0,
            file: None,
            position: 0,
            stream_id,
            done_bytes: 0,
            total_bytes,
            saved,
            last_progress: None,
        };
        let step = download.next()?;
        Ok((download, step))
    }

    /// Moves on to the next request: creates folders, opens files, asks for sizes and ranges.
    fn next(&mut self) -> Result<Step> {
        loop {
            let Some(entry) = self.entries.get(self.current) else {
                return Ok(Step::Done);
            };
            if entry.is_dir {
                std::fs::create_dir_all(&entry.path)
                    .with_context(|| format!("cannot create {}", entry.path.display()))?;
                self.current += 1;
                continue;
            }
            let Some(size) = entry.size else {
                return Ok(Step::Request(self.request(FileContentsFlags::SIZE, 0, 8)));
            };
            if self.file.is_none() {
                if let Some(parent) = entry.path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                self.file = Some(
                    File::create(&entry.path)
                        .with_context(|| format!("cannot create {}", entry.path.display()))?,
                );
                self.position = 0;
            }
            if self.position >= size {
                self.finish_file();
                continue;
            }
            let length = (size - self.position).min(u64::from(CHUNK)) as u32;
            return Ok(Step::Request(self.request(
                FileContentsFlags::DATA,
                self.position,
                length,
            )));
        }
    }

    fn request(
        &mut self,
        flags: FileContentsFlags,
        position: u64,
        requested_size: u32,
    ) -> FileContentsRequest {
        self.stream_id = self.stream_id.wrapping_add(1);
        FileContentsRequest {
            stream_id: self.stream_id,
            index: self.current as u32,
            flags,
            position,
            requested_size,
            data_id: None,
        }
    }

    fn finish_file(&mut self) {
        if let (Some(file), Some(entry)) = (self.file.take(), self.entries.get(self.current))
            && let Some(modified) = entry.modified
        {
            let _ = file.set_modified(modified);
        }
        self.current += 1;
    }

    /// Handles the server's answer to the last request.
    pub fn on_response(&mut self, response: &FileContentsResponse<'_>) -> Result<Step> {
        let entry = self
            .entries
            .get_mut(self.current)
            .context("no transfer in progress")?;
        // IronRDP does not expose the error flag, but failed answers carry no data: neither the
        // 8 bytes of a size nor any of the bytes still missing.
        let name = entry.path.display().to_string();
        let failed = move || anyhow::anyhow!("the remote could not read {name}");
        if entry.size.is_none() {
            let size = response.data_as_size().map_err(|_| failed())?;
            entry.size = Some(size);
            self.total_bytes += size;
            return self.next();
        }
        let data = response.data();
        if data.is_empty() {
            return Err(failed());
        }
        self.file
            .as_mut()
            .context("no file open")?
            .write_all(data)
            .with_context(|| format!("cannot write {}", entry.path.display()))?;
        self.position += data.len() as u64;
        self.done_bytes += data.len() as u64;
        self.next()
    }

    /// The stream id of the request waiting for an answer.
    pub fn stream_id(&self) -> u32 {
        self.stream_id
    }

    /// Whether a progress notice is due (they are throttled).
    pub fn progress_due(&mut self) -> bool {
        let due = self
            .last_progress
            .is_none_or(|last| last.elapsed() >= PROGRESS_EVERY);
        if due {
            self.last_progress = Some(Instant::now());
        }
        due
    }

    /// Stops and removes the file left half written.
    pub fn abort(mut self) {
        if self.file.take().is_some()
            && let Some(entry) = self.entries.get(self.current)
        {
            let _ = std::fs::remove_file(&entry.path);
        }
    }
}

/// What the remote copied, summed up for the UI.
pub fn summary(files: &[FileDescriptor]) -> (Vec<String>, u64) {
    let mut names = Vec::new();
    for file in files {
        let top = file
            .name
            .split(['\\', '/'])
            .next()
            .unwrap_or_default()
            .to_string();
        if !names.contains(&top) {
            names.push(top);
        }
    }
    (names, files.iter().filter_map(|file| file.file_size).sum())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ht-clipfiles-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn remote_names_cannot_escape_the_destination() {
        assert_eq!(relative_path("a\\b.txt"), Some(PathBuf::from("a/b.txt")));
        for bad in [
            "..\\x",
            "a\\..\\..\\x",
            "C:\\x",
            "\\\\server\\x",
            "",
            "a\\\\b",
            "/etc/passwd",
        ] {
            assert_eq!(relative_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn copied_folders_are_listed_recursively_and_served_in_ranges() {
        let dir = temp_dir("out");
        std::fs::create_dir_all(dir.join("docs/sub")).unwrap();
        std::fs::write(dir.join("docs/a.txt"), b"hola").unwrap();
        std::fs::write(dir.join("docs/sub/b.bin"), vec![7u8; 1000]).unwrap();
        std::fs::write(dir.join("solo.txt"), b"x").unwrap();

        let (outgoing, list) = Outgoing::collect(&[dir.join("docs"), dir.join("solo.txt")]);
        let names: Vec<_> = list.files.iter().map(|file| file.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "docs",
                "docs\\a.txt",
                "docs\\sub",
                "docs\\sub\\b.bin",
                "solo.txt"
            ]
        );
        assert_eq!(
            list.files[0].attributes,
            Some(ClipboardFileAttributes::DIRECTORY)
        );
        assert_eq!(list.files[3].file_size, Some(1000));
        assert!(list.files[1].last_write_time.is_some());

        let request = |index, flags, position, requested_size| FileContentsRequest {
            stream_id: 9,
            index,
            flags,
            position,
            requested_size,
            data_id: None,
        };
        let size = outgoing.respond(&request(3, FileContentsFlags::SIZE, 0, 8));
        assert_eq!(size.data_as_size().unwrap(), 1000);
        let range = outgoing.respond(&request(3, FileContentsFlags::DATA, 990, 100));
        assert_eq!(range.data(), &[7u8; 10]);
        assert_eq!(
            outgoing
                .respond(&request(1, FileContentsFlags::DATA, 0, 2))
                .data(),
            b"ho"
        );
        assert!(
            outgoing
                .respond(&request(99, FileContentsFlags::DATA, 0, 2))
                .data()
                .is_empty()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Plays the remote side: answers each request from an [`Outgoing`] list.
    #[test]
    fn downloads_a_copied_tree_without_overwriting_existing_files() {
        let source = temp_dir("src");
        std::fs::create_dir_all(source.join("project/src")).unwrap();
        std::fs::write(
            source.join("project/src/main.rs"),
            vec![1u8; CHUNK as usize * 2 + 5],
        )
        .unwrap();
        std::fs::write(source.join("notes.txt"), b"remote notes").unwrap();
        let (remote, mut list) =
            Outgoing::collect(&[source.join("project"), source.join("notes.txt")]);
        // Some servers leave the size out: it is asked for.
        list.files[2].file_size = None;

        let target = temp_dir("dst");
        std::fs::write(target.join("notes.txt"), b"mine").unwrap();
        let (mut download, mut step) = Download::start(&target, &list.files, 0).unwrap();
        let mut requests = 0;
        while let Step::Request(request) = step {
            requests += 1;
            assert_eq!(request.stream_id, download.stream_id());
            step = download.on_response(&remote.respond(&request)).unwrap();
        }
        assert_eq!(requests, 1 + 3 + 1); // size, three ranges, the small file
        assert_eq!(download.done_bytes, CHUNK as u64 * 2 + 5 + 12);
        assert_eq!(
            download.saved,
            [target.join("project"), target.join("notes (2).txt")]
        );
        assert_eq!(std::fs::read(target.join("notes.txt")).unwrap(), b"mine");
        assert_eq!(
            std::fs::read(target.join("notes (2).txt")).unwrap(),
            b"remote notes"
        );
        assert_eq!(
            std::fs::read(target.join("project/src/main.rs"))
                .unwrap()
                .len(),
            CHUNK as usize * 2 + 5
        );

        std::fs::remove_dir_all(source).unwrap();
        std::fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn filetimes_round_trip() {
        let time = UNIX_EPOCH + Duration::from_secs(1_700_000_000) + Duration::from_micros(5);
        assert_eq!(system_time(filetime(time).unwrap()), Some(time));
    }
}
