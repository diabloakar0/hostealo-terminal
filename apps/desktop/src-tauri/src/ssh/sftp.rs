//! SFTP file browser sessions.
//!
//! `sftp_open` returns an id straight away and connects in the background, reporting progress
//! and prompts through the same `SshEvent`s as terminal sessions. File operations are separate
//! async commands on that id. Transfers walk directories recursively and report progress
//! through a channel; they can be cancelled.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{ClientHandler, Connector, PromptRegistry, SshEvent, Stage, auth};

const CHUNK: usize = 256 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

struct Connected {
    sftp: SftpSession,
    // Keeps the SSH connection alive for as long as the SFTP session is open.
    _ssh: Handle<ClientHandler>,
}

enum Slot {
    Connecting(tauri::async_runtime::JoinHandle<()>),
    Ready(Arc<Connected>),
}

#[derive(Default)]
pub struct SftpState {
    sessions: Mutex<HashMap<u32, Slot>>,
    transfers: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    next_id: AtomicU32,
}

impl SftpState {
    fn get(&self, id: u32) -> Result<Arc<Connected>, String> {
        match self.sessions.lock().map_err(|e| e.to_string())?.get(&id) {
            Some(Slot::Ready(connected)) => Ok(connected.clone()),
            Some(Slot::Connecting(_)) => Err("not connected yet".into()),
            None => Err("session closed".into()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    /// True for directories and for symlinks pointing at one.
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub modified: Option<u32>,
    /// Unix mode bits (`0o755`...).
    pub permissions: Option<u32>,
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transferred: u64,
    pub total: u64,
    pub files_done: usize,
    pub files_total: usize,
    pub current: String,
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub fn sftp_open(
    app: AppHandle,
    state: State<'_, SftpState>,
    registry: State<'_, Arc<PromptRegistry>>,
    host_id: String,
    on_event: Channel<SshEvent>,
) -> Result<u32, String> {
    let mut connector = Connector::for_host(&app, &host_id, &on_event, registry.inner())?;
    // A Windows server reached by remote desktop: its files go over its OpenSSH server, same
    // user and password.
    let windows = connector.host.protocol == crate::hosts::Protocol::Rdp;
    if windows {
        connector.host.port = 22;
    }
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let mut sessions = state.sessions.lock().map_err(err)?;

    let task_app = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let result = async {
            let ssh = connector.connect().await.map_err(|e| {
                if windows && e.downcast_ref::<crate::ssh::auth::Cancelled>().is_none() {
                    e.context("this Windows server does not answer SSH on port 22 (OpenSSH Server is off)")
                } else {
                    e
                }
            })?;
            let channel = ssh.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream())
                .await
                .context("the server has no SFTP subsystem")?;
            anyhow::Ok(Connected { sftp, _ssh: ssh })
        }
        .await;

        let state = task_app.state::<SftpState>();
        let event = match result {
            Ok(connected) => {
                match state.sessions.lock() {
                    // Still wanted: the tab may have been closed while connecting.
                    Ok(mut sessions) if sessions.contains_key(&id) => {
                        sessions.insert(id, Slot::Ready(Arc::new(connected)));
                    }
                    _ => return,
                }
                SshEvent::Status {
                    stage: Stage::Connected,
                }
            }
            Err(e) => {
                if let Ok(mut sessions) = state.sessions.lock() {
                    sessions.remove(&id);
                }
                let error = (!e.is::<auth::Cancelled>()).then(|| format!("{e:#}"));
                SshEvent::Closed {
                    exit_code: None,
                    error,
                }
            }
        };
        let _ = on_event.send(event);
    });
    sessions.insert(id, Slot::Connecting(task));
    Ok(id)
}

#[tauri::command]
pub fn sftp_close(state: State<'_, SftpState>, id: u32) -> Result<(), String> {
    if let Some(Slot::Connecting(task)) = state.sessions.lock().map_err(err)?.remove(&id) {
        task.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_realpath(
    state: State<'_, SftpState>,
    id: u32,
    path: String,
) -> Result<String, String> {
    state.get(id)?.sftp.canonicalize(path).await.map_err(err)
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, SftpState>,
    id: u32,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let session = state.get(id)?;
    let mut entries = Vec::new();
    for entry in session.sftp.read_dir(&path).await.map_err(err)? {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let metadata = entry.metadata();
        let full = join(&path, &name);
        let is_symlink = metadata.is_symlink();
        // A symlink is listed with its own attributes; look at the target to know if it is a folder.
        let is_dir = if is_symlink {
            session.sftp.metadata(&full).await.is_ok_and(|m| m.is_dir())
        } else {
            metadata.is_dir()
        };
        entries.push(SftpEntry {
            name,
            path: full,
            is_dir,
            is_symlink,
            size: metadata.size.unwrap_or(0),
            modified: metadata.mtime,
            permissions: metadata.permissions.map(|p| p & 0o7777),
            owner: metadata
                .user
                .clone()
                .or(metadata.uid.map(|uid| uid.to_string())),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, SftpState>, id: u32, path: String) -> Result<(), String> {
    state.get(id)?.sftp.create_dir(path).await.map_err(err)
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SftpState>,
    id: u32,
    from: String,
    to: String,
) -> Result<(), String> {
    state.get(id)?.sftp.rename(from, to).await.map_err(err)
}

#[tauri::command]
pub async fn sftp_delete(state: State<'_, SftpState>, id: u32, path: String) -> Result<(), String> {
    let session = state.get(id)?;
    remove_recursive(&session.sftp, path)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Deletes a file, a symlink (not its target) or a directory with everything inside.
pub(super) async fn remove_recursive(sftp: &SftpSession, path: String) -> Result<()> {
    let metadata = sftp.symlink_metadata(&path).await?;
    if !metadata.is_dir() {
        return sftp
            .remove_file(&path)
            .await
            .with_context(|| format!("could not delete {path}"));
    }
    // Iterative depth-first walk: directories are removed after their contents.
    let mut stack = vec![(path, false)];
    while let Some((dir, emptied)) = stack.pop() {
        if emptied {
            sftp.remove_dir(&dir)
                .await
                .with_context(|| format!("could not delete {dir}"))?;
            continue;
        }
        stack.push((dir.clone(), true));
        for entry in sftp.read_dir(&dir).await? {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = join(&dir, &name);
            if entry.metadata().is_dir() {
                stack.push((child, false));
            } else {
                sftp.remove_file(&child)
                    .await
                    .with_context(|| format!("could not delete {child}"))?;
            }
        }
    }
    Ok(())
}

/// One file to copy, with paths on both sides.
struct Job {
    remote: String,
    local: PathBuf,
    size: u64,
}

/// Progress of one transfer (shared with FTP): throttled reports and cancellation checks.
pub(crate) struct Progress<'a> {
    channel: &'a Channel<TransferProgress>,
    cancelled: &'a AtomicBool,
    pub(crate) state: TransferProgress,
    last_sent: Instant,
}

impl<'a> Progress<'a> {
    pub(crate) fn new(
        channel: &'a Channel<TransferProgress>,
        cancelled: &'a AtomicBool,
        total: u64,
        files_total: usize,
    ) -> Self {
        Self {
            channel,
            cancelled,
            state: TransferProgress {
                transferred: 0,
                total,
                files_done: 0,
                files_total,
                current: String::new(),
            },
            last_sent: Instant::now(),
        }
    }

    pub(crate) fn advance(&mut self, bytes: u64, current: &str) -> Result<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            bail!("cancelled");
        }
        self.state.transferred += bytes;
        if self.last_sent.elapsed() >= PROGRESS_INTERVAL || self.state.current != current {
            self.state.current = current.to_string();
            self.flush();
        }
        Ok(())
    }

    pub(crate) fn flush(&mut self) {
        self.last_sent = Instant::now();
        let _ = self.channel.send(self.state.clone());
    }
}

fn register_transfer(state: &SftpState, transfer_id: u32) -> Result<Arc<AtomicBool>, String> {
    let flag = Arc::new(AtomicBool::new(false));
    state
        .transfers
        .lock()
        .map_err(err)?
        .insert(transfer_id, flag.clone());
    Ok(flag)
}

/// Downloads a remote file or directory into the local directory `local_dir`.
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, SftpState>,
    id: u32,
    transfer_id: u32,
    remote: String,
    local_dir: String,
    on_progress: Channel<TransferProgress>,
) -> Result<(), String> {
    let session = state.get(id)?;
    let cancelled = register_transfer(&state, transfer_id)?;
    let result = download(
        &session.sftp,
        &remote,
        Path::new(&local_dir),
        &on_progress,
        &cancelled,
    )
    .await;
    if let Ok(mut transfers) = state.transfers.lock() {
        transfers.remove(&transfer_id);
    }
    result.map_err(|e| format!("{e:#}"))
}

pub(super) async fn download(
    sftp: &SftpSession,
    remote: &str,
    local_dir: &Path,
    channel: &Channel<TransferProgress>,
    cancelled: &AtomicBool,
) -> Result<()> {
    let name = remote
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or("download");
    let root = local_dir.join(name);

    // Plan first, so progress can show a total.
    let mut jobs = Vec::new();
    let mut dirs = Vec::new();
    let metadata = sftp
        .metadata(remote)
        .await
        .with_context(|| format!("{remote} not found"))?;
    if metadata.is_dir() {
        let mut stack = vec![(remote.to_string(), root.clone())];
        while let Some((remote_dir, local)) = stack.pop() {
            dirs.push(local.clone());
            for entry in sftp.read_dir(&remote_dir).await? {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let meta = entry.metadata();
                let (remote_child, local_child) = (join(&remote_dir, &name), local.join(&name));
                if meta.is_dir() {
                    stack.push((remote_child, local_child));
                } else if !meta.is_symlink() {
                    jobs.push(Job {
                        remote: remote_child,
                        local: local_child,
                        size: meta.size.unwrap_or(0),
                    });
                }
            }
        }
    } else {
        jobs.push(Job {
            remote: remote.to_string(),
            local: root.clone(),
            size: metadata.size.unwrap_or(0),
        });
    }

    let mut progress = Progress {
        channel,
        cancelled,
        state: TransferProgress {
            transferred: 0,
            total: jobs.iter().map(|j| j.size).sum(),
            files_done: 0,
            files_total: jobs.len(),
            current: String::new(),
        },
        last_sent: Instant::now(),
    };
    for dir in &dirs {
        tokio::fs::create_dir_all(dir)
            .await
            .with_context(|| format!("could not create {}", dir.display()))?;
    }
    let mut buffer = vec![0u8; CHUNK];
    for job in jobs {
        let result = async {
            let mut source = sftp
                .open(&job.remote)
                .await
                .with_context(|| format!("could not open {}", job.remote))?;
            let mut target = tokio::fs::File::create(&job.local)
                .await
                .with_context(|| format!("could not create {}", job.local.display()))?;
            loop {
                let n = source.read(&mut buffer).await?;
                if n == 0 {
                    break;
                }
                target.write_all(&buffer[..n]).await?;
                progress.advance(n as u64, &job.remote)?;
            }
            target.flush().await?;
            anyhow::Ok(())
        }
        .await;
        if result.is_err() {
            // Don't leave a truncated file behind.
            let _ = tokio::fs::remove_file(&job.local).await;
        }
        result?;
        progress.state.files_done += 1;
    }
    progress.flush();
    Ok(())
}

/// Uploads local files or directories into the remote directory `remote_dir`.
#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, SftpState>,
    id: u32,
    transfer_id: u32,
    locals: Vec<String>,
    remote_dir: String,
    on_progress: Channel<TransferProgress>,
) -> Result<(), String> {
    let session = state.get(id)?;
    let cancelled = register_transfer(&state, transfer_id)?;
    let result = upload(
        &session.sftp,
        &locals,
        &remote_dir,
        &on_progress,
        &cancelled,
    )
    .await;
    if let Ok(mut transfers) = state.transfers.lock() {
        transfers.remove(&transfer_id);
    }
    result.map_err(|e| format!("{e:#}"))
}

pub(super) async fn upload(
    sftp: &SftpSession,
    locals: &[String],
    remote_dir: &str,
    channel: &Channel<TransferProgress>,
    cancelled: &AtomicBool,
) -> Result<()> {
    let mut jobs = Vec::new();
    let mut dirs = Vec::new();
    for local in locals {
        let local = PathBuf::from(local);
        let name = local
            .file_name()
            .context("invalid path")?
            .to_string_lossy()
            .into_owned();
        let metadata = tokio::fs::metadata(&local)
            .await
            .with_context(|| format!("{} not found", local.display()))?;
        if metadata.is_dir() {
            let mut stack = vec![(local.clone(), join(remote_dir, &name))];
            while let Some((local_dir, remote)) = stack.pop() {
                dirs.push(remote.clone());
                let mut entries = tokio::fs::read_dir(&local_dir).await?;
                while let Some(entry) = entries.next_entry().await? {
                    let child_name = entry.file_name().to_string_lossy().into_owned();
                    let file_type = entry.file_type().await?;
                    let remote_child = join(&remote, &child_name);
                    if file_type.is_dir() {
                        stack.push((entry.path(), remote_child));
                    } else if file_type.is_file() {
                        let size = entry.metadata().await?.len();
                        jobs.push(Job {
                            remote: remote_child,
                            local: entry.path(),
                            size,
                        });
                    }
                }
            }
        } else {
            jobs.push(Job {
                remote: join(remote_dir, &name),
                local,
                size: metadata.len(),
            });
        }
    }

    let mut progress = Progress {
        channel,
        cancelled,
        state: TransferProgress {
            transferred: 0,
            total: jobs.iter().map(|j| j.size).sum(),
            files_done: 0,
            files_total: jobs.len(),
            current: String::new(),
        },
        last_sent: Instant::now(),
    };
    for dir in &dirs {
        // The folder may already exist; a real failure shows up when writing into it.
        if !sftp.try_exists(dir).await.unwrap_or(false) {
            sftp.create_dir(dir)
                .await
                .with_context(|| format!("could not create {dir}"))?;
        }
    }
    let mut buffer = vec![0u8; CHUNK];
    for job in jobs {
        let mut source = tokio::fs::File::open(&job.local)
            .await
            .with_context(|| format!("could not open {}", job.local.display()))?;
        let mut target = sftp
            .open_with_flags(
                &job.remote,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .with_context(|| format!("could not create {}", job.remote))?;
        loop {
            let n = source.read(&mut buffer).await?;
            if n == 0 {
                break;
            }
            target.write_all(&buffer[..n]).await?;
            progress.advance(n as u64, &job.remote)?;
        }
        target.shutdown().await?;
        progress.state.files_done += 1;
    }
    progress.flush();
    Ok(())
}

#[tauri::command]
pub fn sftp_cancel_transfer(state: State<'_, SftpState>, transfer_id: u32) -> Result<(), String> {
    if let Some(flag) = state.transfers.lock().map_err(err)?.get(&transfer_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
