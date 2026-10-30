//! This computer's files, for the local side of the two-pane file browser (like FileZilla's).
//! Paths are handled here, not in the UI, so Windows drive letters and backslashes just work.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::ssh::sftp::SftpEntry;
use crate::text_file::{self, Encoding, TextFile};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalListing {
    /// The folder, absolute.
    pub path: String,
    /// Its parent, or `None` at the root of a drive.
    pub parent: Option<String>,
    pub entries: Vec<SftpEntry>,
}

fn home() -> PathBuf {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    // On iOS HOME is the app's sandbox; its Documents folder is the one the Files app shows.
    if cfg!(target_os = "ios") {
        let documents = home.join("Documents");
        let _ = std::fs::create_dir_all(&documents);
        return documents;
    }
    home
}

/// `~` and `~/...` to the home folder.
fn expand(path: &str) -> PathBuf {
    match path.strip_prefix('~') {
        Some(rest) => home().join(rest.trim_start_matches(['/', '\\'])),
        None => PathBuf::from(path),
    }
}

#[cfg(unix)]
fn permissions(metadata: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(metadata.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn permissions(_metadata: &std::fs::Metadata) -> Option<u32> {
    None
}

fn entry(path: &Path) -> Option<SftpEntry> {
    let link = std::fs::symlink_metadata(path).ok()?;
    // Links show what they point to (a broken one shows as a file).
    let metadata = if link.is_symlink() {
        std::fs::metadata(path).unwrap_or(link.clone())
    } else {
        link.clone()
    };
    Some(SftpEntry {
        name: path.file_name()?.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        is_dir: metadata.is_dir(),
        is_symlink: link.is_symlink(),
        size: if metadata.is_dir() { 0 } else { metadata.len() },
        modified: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_secs() as u32),
        permissions: permissions(&metadata),
        owner: None,
    })
}

pub fn list(path: &str) -> Result<LocalListing, String> {
    let dir = expand(path);
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut entries: Vec<SftpEntry> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .filter_map(|item| entry(&item.path()))
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(LocalListing {
        path: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
    })
}

/// A name for a new item, refused if it would land somewhere else.
fn child(dir: &str, name: &str) -> Result<PathBuf, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(format!("invalid name: {name}"));
    }
    Ok(expand(dir).join(name))
}

#[tauri::command]
pub fn local_home() -> String {
    home().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn local_list(path: String) -> Result<LocalListing, String> {
    list(&path)
}

#[tauri::command]
pub fn local_mkdir(dir: String, name: String) -> Result<(), String> {
    std::fs::create_dir(child(&dir, &name)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_rename(path: String, name: String) -> Result<(), String> {
    let from = expand(&path);
    let parent = from.parent().ok_or("cannot rename a drive")?;
    let to = child(&parent.to_string_lossy(), &name)?;
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Deletes a file, or a folder with everything inside it (links are removed, never followed).
#[tauri::command]
pub fn local_delete(path: String) -> Result<(), String> {
    let path = expand(&path);
    let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(&path)
    } else {
        std::fs::remove_file(&path)
    }
    .map_err(|e| format!("{}: {e}", path.display()))
}

fn modified_secs(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_secs())
}

/// Reads a text file for the editor.
#[tauri::command]
pub fn local_read_text(path: String) -> Result<TextFile, String> {
    let path = expand(&path);
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > text_file::MAX_BYTES {
        return Err(text_file::TOO_LARGE.into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let (content, encoding) = text_file::decode(&bytes)?;
    Ok(TextFile {
        content,
        encoding,
        modified: modified_secs(&path),
    })
}

/// Saves the editor's text. With `expected_modified`, refuses if the file changed since it was
/// read (`changed`); returns the new modification time.
#[tauri::command]
pub fn local_write_text(
    path: String,
    content: String,
    encoding: Encoding,
    expected_modified: Option<u64>,
) -> Result<Option<u64>, String> {
    let path = expand(&path);
    let bytes = text_file::encode(&content, encoding)?;
    if let Some(expected) = expected_modified
        && modified_secs(&path).is_some_and(|m| m != expected)
    {
        return Err(text_file::CHANGED.into());
    }
    std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(modified_secs(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_a_text_file_and_notices_changes_made_meanwhile() {
        let dir = std::env::temp_dir().join(format!("ht-localedit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("site.conf");
        std::fs::write(&file, b"server {\r\n}\r\n").unwrap();
        let path = file.to_string_lossy().into_owned();

        let opened = local_read_text(path.clone()).unwrap();
        assert_eq!(opened.content, "server {\r\n}\r\n");
        let saved = local_write_text(
            path.clone(),
            "server { listen 80; }\r\n".into(),
            opened.encoding,
            opened.modified,
        )
        .unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"server { listen 80; }\r\n");

        // Someone else saves it: the next save with the old time is refused.
        let stale = saved.map(|m| m - 10);
        assert_eq!(
            local_write_text(path.clone(), "x".into(), Encoding::Utf8, stale).unwrap_err(),
            text_file::CHANGED
        );

        std::fs::write(dir.join("logo.png"), b"\x89PNG\0\0").unwrap();
        assert_eq!(
            local_read_text(dir.join("logo.png").to_string_lossy().into_owned())
                .err()
                .as_deref(),
            Some(text_file::BINARY)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lists_creates_renames_and_deletes() {
        let dir = std::env::temp_dir().join(format!("ht-localfs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let base = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("b.txt"), b"hola").unwrap();
        local_mkdir(base.clone(), "Zeta".into()).unwrap();
        local_mkdir(base.clone(), "alfa".into()).unwrap();

        let listing = list(&base).unwrap();
        let names: Vec<_> = listing
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.is_dir))
            .collect();
        assert_eq!(names, [("alfa", true), ("Zeta", true), ("b.txt", false)]);
        assert_eq!(listing.entries[2].size, 4);
        assert!(listing.parent.is_some());

        let file = listing.entries[2].path.clone();
        local_rename(file, "c.txt".into()).unwrap();
        assert!(dir.join("c.txt").exists());
        assert!(local_mkdir(base.clone(), "../escape".into()).is_err());

        std::fs::write(dir.join("Zeta/inside"), b"x").unwrap();
        local_delete(dir.join("Zeta").to_string_lossy().into_owned()).unwrap();
        assert!(!dir.join("Zeta").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
