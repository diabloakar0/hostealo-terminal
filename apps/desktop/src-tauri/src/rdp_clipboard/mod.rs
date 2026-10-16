//! Shared clipboard for remote desktop sessions: text, images and files, both ways.
//!
//! - Remote → local: when the server announces new clipboard content, text and images are
//!   fetched right away and written to the local clipboard, so they can be pasted in any local
//!   app. Copied files are only listed: the UI offers to save them into a folder (see `files`).
//! - Local → remote: a watcher notices local clipboard changes and announces them to the
//!   server, which asks for the data (text, a DIB image, or files in ranges) when something is
//!   pasted remotely.
//!
//! Clipboards that "stop working" usually got out of sync: one side announced content the other
//! missed. Here every change is re-announced, content that came from the remote is never echoed
//! back, and the UI asks for a re-sync whenever the session tab gets the focus.

pub mod dib;
mod files;

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardFormatName, ClipboardGeneralCapabilityFlags,
    FileContentsRequest, FileContentsResponse, FileDescriptor, FormatDataRequest,
    FormatDataResponse, LockDataId, OwnedFormatDataResponse,
};
use ironrdp::core::impl_as_any;
use serde::Serialize;
use tokio::sync::mpsc;

use files::{Download, Outgoing, Step};

/// How often the local clipboard is checked for changes.
const POLL_INTERVAL: Duration = Duration::from_millis(400);

/// Id under which local files are announced (any id in the registered range works: the
/// format is recognised by its name).
fn file_list_format() -> ClipboardFormat {
    ClipboardFormat::new(ClipboardFormatId::new(0xC0F0)).with_name(ClipboardFormatName::FILE_LIST)
}

fn is_file_list(format: &ClipboardFormat) -> bool {
    format.name.as_ref().is_some_and(|name| {
        name.value()
            .eq_ignore_ascii_case(ClipboardFormatName::FILE_LIST.value())
    })
}

/// An image as RGBA rows.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

/// What the local clipboard holds.
#[derive(Debug, Default, Clone, PartialEq, Eq, Hash)]
pub struct Snapshot {
    pub text: Option<String>,
    pub image: Option<Image>,
    pub files: Vec<PathBuf>,
}

/// Access to the local clipboard (the OS one in the app, a fake one in tests).
pub trait LocalClipboard: Send + Sync + 'static {
    /// A counter that changes with every copy, on systems that have one.
    fn change_count(&self) -> Option<u64> {
        None
    }
    fn text(&self) -> Option<String>;
    fn image(&self) -> Option<Image>;
    fn files(&self) -> Vec<PathBuf>;
    fn set_text(&self, text: &str);
    fn set_image(&self, image: &Image);
}

/// Clipboard news for the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Notice {
    /// Files were copied on the remote (an empty list: it copied something else since).
    RemoteFiles {
        names: Vec<String>,
        count: usize,
        bytes: u64,
    },
    /// Saving remote files.
    Progress {
        done: u64,
        total: u64,
    },
    /// The remote files were saved; `paths` are the copied items as saved.
    Saved {
        paths: Vec<PathBuf>,
    },
    Failed {
        error: String,
    },
    Cancelled,
}

/// What the clipboard needs the session to do.
#[derive(Debug)]
pub enum ClipboardEvent {
    /// The local clipboard changed: send the list of available formats.
    Announce(Vec<ClipboardFormat>),
    /// Answer to the server asking for our clipboard content.
    Data(OwnedFormatDataResponse),
    /// Ask the server for its clipboard content in this format.
    Fetch(ClipboardFormatId),
    /// Answer to the server asking for (part of) a file we copied.
    FileContents(FileContentsResponse<'static>),
    /// Ask the server for (part of) a file it copied.
    RequestFileContents(FileContentsRequest),
    /// Tell the UI.
    Notice(Notice),
}

/// Data asked from the remote, waiting for its answer.
#[derive(Debug, Clone, Copy)]
enum Pending {
    Text { unicode: bool },
    Image,
    Files,
}

#[derive(Default)]
struct State {
    /// Change mark of the local clipboard when it was last looked at.
    mark: Option<u64>,
    /// Hash of the content last announced, or last written from the remote.
    content: Option<u64>,
    /// The content last announced, served when the remote pastes.
    snapshot: Snapshot,
    /// Files listed for the remote at its last request for the file list.
    outgoing: Outgoing,
    /// Whether the server takes files.
    files_enabled: bool,
    pending: Option<Pending>,
    /// Files the remote copied, until it copies something else.
    remote_files: Vec<FileDescriptor>,
    download: Option<Download>,
    downloads: u32,
}

struct Inner {
    local: Arc<dyn LocalClipboard>,
    events: mpsc::UnboundedSender<ClipboardEvent>,
    state: Mutex<State>,
}

fn hash_of(value: &impl Hash) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

impl Inner {
    fn send(&self, event: ClipboardEvent) {
        let _ = self.events.send(event);
    }

    fn notify(&self, notice: Notice) {
        self.send(ClipboardEvent::Notice(notice));
    }

    /// Cheap check for changes: the system counter, or else a hash of the text and file list
    /// (on such systems an image replacing another image is only seen on re-sync).
    fn mark(&self) -> u64 {
        self.local
            .change_count()
            .unwrap_or_else(|| hash_of(&(self.local.text(), self.local.files())))
    }

    fn read(&self) -> Snapshot {
        let files = self.local.files();
        Snapshot {
            text: self.local.text(),
            // A copied file also comes with its icon as an image: the files are what matters.
            image: if files.is_empty() {
                self.local.image()
            } else {
                None
            },
            files,
        }
    }

    /// Announces the local clipboard, unless it holds what was last announced or received.
    fn announce(&self, force: bool) {
        let mark = self.mark();
        let snapshot = self.read();
        let hash = hash_of(&snapshot);
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.mark = Some(mark);
        if !force && state.content == Some(hash) {
            return;
        }
        let mut formats = Vec::new();
        if !snapshot.files.is_empty() && state.files_enabled {
            formats.push(file_list_format());
        }
        if snapshot.image.is_some() {
            formats.push(ClipboardFormat::new(ClipboardFormatId::CF_DIB));
        }
        if snapshot
            .text
            .as_deref()
            .is_some_and(|text| !text.is_empty())
        {
            formats.push(ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT));
        }
        state.content = Some(hash);
        state.snapshot = snapshot;
        state.outgoing = Outgoing::default();
        drop(state);
        self.send(ClipboardEvent::Announce(formats));
    }

    /// Announces the local clipboard if it changed. `thorough` also looks at content the
    /// change mark may miss.
    fn check(&self, thorough: bool) {
        let mark = self.mark();
        let unchanged = self
            .state
            .lock()
            .is_ok_and(|state| state.mark == Some(mark));
        if unchanged && !(thorough && self.local.change_count().is_none()) {
            return;
        }
        self.announce(false);
    }

    /// Writes content from the remote to the local clipboard, remembering it so it is not
    /// announced back.
    fn store_remote(&self, write: impl FnOnce(&dyn LocalClipboard)) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        write(&*self.local);
        let snapshot = self.read();
        state.mark = Some(self.mark());
        state.content = Some(hash_of(&snapshot));
        state.snapshot = snapshot;
        state.outgoing = Outgoing::default();
    }

    fn save_remote_files(&self, dir: PathBuf) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.download.is_some() {
            return;
        }
        if state.remote_files.is_empty() {
            drop(state);
            return self.notify(Notice::Failed {
                error: "the remote clipboard has no files".into(),
            });
        }
        state.downloads += 1;
        let stream_id = state.downloads << 20;
        match Download::start(&dir, &state.remote_files, stream_id) {
            Ok((mut download, Step::Request(request))) => {
                download.progress_due();
                let total = download.total_bytes;
                state.download = Some(download);
                drop(state);
                self.notify(Notice::Progress { done: 0, total });
                self.send(ClipboardEvent::RequestFileContents(request));
            }
            Ok((download, Step::Done)) => {
                drop(state);
                self.notify(Notice::Saved {
                    paths: download.saved,
                });
            }
            Err(error) => {
                drop(state);
                self.notify(Notice::Failed {
                    error: format!("{error:#}"),
                });
            }
        }
    }

    fn cancel_download(&self) {
        let download = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.download.take());
        if let Some(download) = download {
            download.abort();
            self.notify(Notice::Cancelled);
        }
    }
}

/// One clipboard link between a session and the local clipboard.
pub struct ClipboardLink {
    inner: Arc<Inner>,
    stop: Arc<AtomicBool>,
}

impl ClipboardLink {
    pub fn new(local: Arc<dyn LocalClipboard>) -> (Self, mpsc::UnboundedReceiver<ClipboardEvent>) {
        let (events, receiver) = mpsc::unbounded_channel();
        let link = Self {
            inner: Arc::new(Inner {
                local,
                events,
                state: Mutex::default(),
            }),
            stop: Arc::default(),
        };
        (link, receiver)
    }

    /// The backend handed to IronRDP's clipboard channel.
    pub fn backend(&self) -> Backend {
        Backend {
            inner: self.inner.clone(),
        }
    }

    /// Announces the local clipboard if it changed while the session tab was not focused.
    pub fn resync(&self) {
        self.inner.check(true);
    }

    /// Saves the files the remote copied into `dir`; progress comes as notices.
    pub fn save_remote_files(&self, dir: PathBuf) {
        self.inner.save_remote_files(dir);
    }

    pub fn cancel_download(&self) {
        self.inner.cancel_download();
    }

    /// Watches the local clipboard on a background thread until the link is dropped.
    pub fn watch(&self) {
        let (inner, stop) = (self.inner.clone(), self.stop.clone());
        // Without a watcher, local copies are still announced whenever the tab gets the focus.
        let _ = std::thread::Builder::new()
            .name("rdp-clipboard".into())
            .spawn(move || {
                while !stop.load(Ordering::Relaxed) && !inner.events.is_closed() {
                    std::thread::sleep(POLL_INTERVAL);
                    inner.check(false);
                }
            });
    }
}

impl Drop for ClipboardLink {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.inner.cancel_download();
    }
}

/// Windows expects CRLF line endings.
pub fn to_remote_text(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

/// macOS and Linux use LF; the remote text may also end with a NUL terminator.
pub fn from_remote_text(text: &str) -> String {
    let text = text.trim_end_matches('\0');
    if cfg!(windows) {
        text.to_string()
    } else {
        text.replace("\r\n", "\n")
    }
}

/// IronRDP's clipboard backend: turns channel callbacks into [`ClipboardEvent`]s.
#[derive(Clone)]
pub struct Backend {
    inner: Arc<Inner>,
}

impl core::fmt::Debug for Backend {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("rdp clipboard backend")
    }
}

impl_as_any!(Backend);

impl CliprdrBackend for Backend {
    fn temporary_directory(&self) -> &str {
        ".cliprdr"
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
            | ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
            | ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS
    }

    fn on_ready(&mut self) {}

    /// The channel is starting: tell the server what we have (possibly nothing).
    fn on_request_format_list(&mut self) {
        self.inner.announce(true);
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        capabilities: ClipboardGeneralCapabilityFlags,
    ) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.files_enabled =
                capabilities.contains(ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED);
        }
    }

    /// Something was copied remotely: fetch text and images now, so they can be pasted locally
    /// anywhere; for files, fetch the list.
    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        let find = |id: ClipboardFormatId| available_formats.iter().find(|format| format.id == id);
        let wanted = available_formats
            .iter()
            .find(|format| is_file_list(format))
            .map(|format| (Pending::Files, format.id))
            .or_else(|| {
                find(ClipboardFormatId::CF_UNICODETEXT)
                    .map(|f| (Pending::Text { unicode: true }, f.id))
            })
            .or_else(|| {
                find(ClipboardFormatId::CF_TEXT).map(|f| (Pending::Text { unicode: false }, f.id))
            })
            .or_else(|| find(ClipboardFormatId::CF_DIB).map(|f| (Pending::Image, f.id)))
            .or_else(|| find(ClipboardFormatId::CF_DIBV5).map(|f| (Pending::Image, f.id)));

        let Ok(mut state) = self.inner.state.lock() else {
            return;
        };
        // Whatever the remote had before is gone.
        let download = state.download.take();
        let had_files = !std::mem::take(&mut state.remote_files).is_empty();
        state.pending = wanted.map(|(pending, _)| pending);
        drop(state);
        if let Some(download) = download {
            download.abort();
            self.inner.notify(Notice::Failed {
                error: "the remote clipboard changed".into(),
            });
        }
        if had_files {
            self.inner.notify(Notice::RemoteFiles {
                names: Vec::new(),
                count: 0,
                bytes: 0,
            });
        }
        if let Some((_, id)) = wanted {
            self.inner.send(ClipboardEvent::Fetch(id));
        }
    }

    /// Something is being pasted remotely: send what was announced.
    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let Ok(mut state) = self.inner.state.lock() else {
            return;
        };
        let snapshot = &state.snapshot;
        let response = match request.format {
            ClipboardFormatId::CF_UNICODETEXT => snapshot
                .text
                .as_deref()
                .map(|text| OwnedFormatDataResponse::new_unicode_string(&to_remote_text(text))),
            ClipboardFormatId::CF_TEXT => snapshot
                .text
                .as_deref()
                .map(|text| OwnedFormatDataResponse::new_string(&to_remote_text(text))),
            ClipboardFormatId::CF_DIB => snapshot
                .image
                .as_ref()
                .map(|image| OwnedFormatDataResponse::new_data(dib::encode(image))),
            id if id == file_list_format().id && !snapshot.files.is_empty() => {
                let (outgoing, list) = Outgoing::collect(&snapshot.files);
                state.outgoing = outgoing;
                OwnedFormatDataResponse::new_file_list(&list).ok()
            }
            _ => None,
        };
        drop(state);
        self.inner.send(ClipboardEvent::Data(
            response.unwrap_or_else(OwnedFormatDataResponse::new_error),
        ));
    }

    /// The remote content arrived: put it on the local clipboard, or list the files.
    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        let pending = self
            .inner
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.pending.take());
        if response.is_error() {
            return;
        }
        match pending {
            Some(Pending::Text { unicode }) => {
                let decoded = if unicode {
                    response.to_unicode_string()
                } else {
                    response.to_string()
                };
                if let Ok(text) = decoded {
                    let text = from_remote_text(&text);
                    self.inner.store_remote(|local| local.set_text(&text));
                }
            }
            Some(Pending::Image) => {
                if let Some(image) = dib::decode(response.data()) {
                    self.inner.store_remote(|local| local.set_image(&image));
                }
            }
            Some(Pending::Files) => {
                let Ok(list) = response.to_file_list() else {
                    return;
                };
                let (names, bytes) = files::summary(&list.files);
                let count = list.files.len();
                if let Ok(mut state) = self.inner.state.lock() {
                    state.remote_files = list.files;
                }
                self.inner.notify(Notice::RemoteFiles {
                    names,
                    count,
                    bytes,
                });
            }
            None => {}
        }
    }

    /// The remote is pasting files we copied: send a size or a range.
    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        let response = match self.inner.state.lock() {
            Ok(state) => state.outgoing.respond(&request),
            Err(_) => FileContentsResponse::new_error(request.stream_id),
        };
        self.inner.send(ClipboardEvent::FileContents(response));
    }

    /// A part of a remote file we are saving arrived.
    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        let Ok(mut state) = self.inner.state.lock() else {
            return;
        };
        let Some(download) = state.download.as_mut() else {
            return;
        };
        if response.stream_id() != download.stream_id() {
            return;
        }
        match download.on_response(&response) {
            Ok(Step::Request(request)) => {
                let progress = download.progress_due().then_some(Notice::Progress {
                    done: download.done_bytes,
                    total: download.total_bytes,
                });
                drop(state);
                self.inner
                    .send(ClipboardEvent::RequestFileContents(request));
                if let Some(progress) = progress {
                    self.inner.notify(progress);
                }
            }
            Ok(Step::Done) => {
                let download = state.download.take().expect("checked above");
                drop(state);
                self.inner.notify(Notice::Saved {
                    paths: download.saved,
                });
            }
            Err(error) => {
                let download = state.download.take().expect("checked above");
                drop(state);
                download.abort();
                self.inner.notify(Notice::Failed {
                    error: format!("{error:#}"),
                });
            }
        }
    }

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

/// The operating system clipboard.
#[cfg(desktop)]
pub struct SystemClipboard(Mutex<Option<arboard::Clipboard>>);

#[cfg(desktop)]
impl Default for SystemClipboard {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(desktop)]
impl SystemClipboard {
    pub fn new() -> Self {
        Self(Mutex::new(arboard::Clipboard::new().ok()))
    }

    /// Runs `f` with the clipboard, kept open for the session (on Linux, content we set lives
    /// only as long as it is open).
    fn with<R>(&self, f: impl FnOnce(&mut arboard::Clipboard) -> Option<R>) -> Option<R> {
        let mut clipboard = self.0.lock().ok()?;
        if clipboard.is_none() {
            *clipboard = arboard::Clipboard::new().ok();
        }
        f(clipboard.as_mut()?)
    }
}

#[cfg(desktop)]
impl LocalClipboard for SystemClipboard {
    #[cfg(target_os = "macos")]
    fn change_count(&self) -> Option<u64> {
        Some(objc2_app_kit::NSPasteboard::generalPasteboard().changeCount() as u64)
    }

    #[cfg(windows)]
    fn change_count(&self) -> Option<u64> {
        // SAFETY: no arguments; returns 0 when the clipboard cannot be accessed.
        let count =
            unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() };
        (count != 0).then_some(u64::from(count))
    }

    fn text(&self) -> Option<String> {
        self.with(|clipboard| clipboard.get_text().ok())
    }

    fn image(&self) -> Option<Image> {
        let image = self.with(|clipboard| clipboard.get_image().ok())?;
        Some(Image {
            width: image.width,
            height: image.height,
            rgba: image.bytes.into_owned(),
        })
    }

    fn files(&self) -> Vec<PathBuf> {
        self.with(|clipboard| clipboard.get().file_list().ok())
            .unwrap_or_default()
    }

    fn set_text(&self, text: &str) {
        self.with(|clipboard| clipboard.set_text(text).ok());
    }

    fn set_image(&self, image: &Image) {
        self.with(|clipboard| {
            clipboard
                .set_image(arboard::ImageData {
                    width: image.width,
                    height: image.height,
                    bytes: std::borrow::Cow::Borrowed(&image.rgba),
                })
                .ok()
        });
    }
}

/// An in-memory clipboard (tests, and platforms without clipboard access).
#[cfg(any(test, mobile))]
#[derive(Default)]
pub struct MemoryClipboard {
    content: Mutex<Snapshot>,
    changes: std::sync::atomic::AtomicU64,
}

#[cfg(any(test, mobile))]
impl MemoryClipboard {
    pub fn set(&self, snapshot: Snapshot) {
        if let Ok(mut content) = self.content.lock() {
            *content = snapshot;
            self.changes.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn get(&self) -> Snapshot {
        self.content
            .lock()
            .map(|content| content.clone())
            .unwrap_or_default()
    }
}

#[cfg(any(test, mobile))]
impl LocalClipboard for MemoryClipboard {
    fn change_count(&self) -> Option<u64> {
        Some(self.changes.load(Ordering::Relaxed))
    }

    fn text(&self) -> Option<String> {
        self.get().text
    }

    fn image(&self) -> Option<Image> {
        self.get().image
    }

    fn files(&self) -> Vec<PathBuf> {
        self.get().files
    }

    fn set_text(&self, text: &str) {
        self.set(Snapshot {
            text: Some(text.to_string()),
            ..Snapshot::default()
        });
    }

    fn set_image(&self, image: &Image) {
        self.set(Snapshot {
            image: Some(image.clone()),
            ..Snapshot::default()
        });
    }
}

#[cfg(test)]
mod tests;
