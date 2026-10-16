//! Interactive SSH sessions.
//!
//! `ssh_connect` returns a session id straight away and runs the connection in a background
//! task. The task reports progress and questions through `on_event`, terminal output through
//! `on_data` (raw bytes) and resource usage through `on_monitor`. The UI talks back with
//! `ssh_write`, `ssh_resize`, `ssh_close` and `ssh_prompt_reply`.

mod auth;
mod known_hosts;
mod monitor;
mod os;
mod prompts;
pub mod remote;
pub mod sftp;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use russh::keys::{HashAlg, PublicKey};
use russh::{ChannelMsg, Disconnect, client};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};

use crate::hosts::{Host, HostStore};
use crate::secrets::{self, SecretKind};
pub use auth::Cancelled;
use known_hosts::HostKeyStatus;
pub use monitor::MonitorEvent;
pub use prompts::{PromptField, PromptKind, PromptRegistry, PromptReply, Prompter};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Saves a secret to the keychain and records it on the host. A closure, so sessions can run
/// without a Tauri app (tests).
pub type SecretSaver = dyn Fn(SecretKind, &str) -> Result<(), String> + Send + Sync;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Connecting,
    Authenticating,
    Connected,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SshEvent {
    Status {
        stage: Stage,
    },
    HostKey {
        request_id: u64,
        algorithm: String,
        fingerprint: String,
        /// The host presented a different key than the one on record.
        changed: bool,
    },
    /// An FTPS server certificate that could not be verified (self-signed, other host name...).
    Certificate {
        request_id: u64,
        fingerprint: String,
        reason: String,
        /// A different certificate was trusted before for this server.
        changed: bool,
    },
    Prompt {
        request_id: u64,
        kind: PromptKind,
        name: String,
        instructions: String,
        prompts: Vec<PromptField>,
        can_remember: bool,
        /// The previous answer was rejected.
        retry: bool,
    },
    Banner {
        message: String,
    },
    /// The server's operating system, detected after connecting.
    Os {
        os: crate::hosts::HostOs,
    },
    Closed {
        exit_code: Option<u32>,
        /// `None` for a normal logout or when the user cancelled.
        error: Option<String>,
    },
}

enum Command {
    Data(Vec<u8>),
    Resize {
        cols: u32,
        rows: u32,
    },
    /// Run a command on its own channel (the assistant's agent mode) and reply with its output.
    Exec {
        command: String,
        timeout: Duration,
        reply: tokio::sync::oneshot::Sender<Result<crate::exec::ExecOutput, String>>,
    },
    Close,
}

struct SessionHandle {
    commands: mpsc::UnboundedSender<Command>,
    cancel: watch::Sender<bool>,
}

#[derive(Default)]
pub struct SshState {
    sessions: Mutex<HashMap<u32, SessionHandle>>,
    next_id: AtomicU32,
}

impl SshState {
    fn send(&self, id: u32, command: Command) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(&id).ok_or("session not found")?;
        session
            .commands
            .send(command)
            .map_err(|_| "session closed".to_string())
    }
}

pub struct ClientHandler {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    prompter: Prompter,
}

impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool> {
        let key = match server_key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            russh::keys::PublicKeyOrCertificate::Certificate(cert) => {
                PublicKey::from(cert.public_key().clone())
            }
        };
        let status = known_hosts::status(&self.host, self.port, &key, &self.known_hosts);
        if status == HostKeyStatus::Trusted {
            return Ok(true);
        }

        let reply = self
            .prompter
            .ask(|request_id| SshEvent::HostKey {
                request_id,
                algorithm: key.algorithm().to_string(),
                fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
                changed: status == HostKeyStatus::Changed,
            })
            .await;
        match reply {
            PromptReply::HostKey { accept: true } => {
                known_hosts::trust(&self.host, self.port, &key, &self.known_hosts)
                    .map_err(anyhow::Error::msg)?;
                Ok(true)
            }
            _ => Err(auth::Cancelled.into()),
        }
    }

    async fn auth_banner(&mut self, banner: &str, _session: &mut client::Session) -> Result<()> {
        self.prompter.notify(SshEvent::Banner {
            message: banner.to_string(),
        });
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshState>,
    registry: State<'_, Arc<PromptRegistry>>,
    host_id: String,
    cols: u32,
    rows: u32,
    on_event: Channel<SshEvent>,
    on_data: Channel<InvokeResponseBody>,
    on_monitor: Channel<MonitorEvent>,
) -> Result<u32, String> {
    let connector = Connector::for_host(&app, &host_id, &on_event, registry.inner())?;

    let (commands, command_rx) = mpsc::unbounded_channel();
    let (cancel, cancel_rx) = watch::channel(false);
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, SessionHandle { commands, cancel });

    tauri::async_runtime::spawn(async move {
        let session = Session {
            connector,
            cols,
            rows,
        };
        let outcome = tokio::select! {
            result = session.run(command_rx, on_data, on_monitor) => result,
            _ = wait_cancelled(cancel_rx) => Ok(None),
        };
        if let Ok(mut sessions) = app.state::<SshState>().sessions.lock() {
            sessions.remove(&id);
        }
        let event = match outcome {
            Ok(exit_code) => SshEvent::Closed {
                exit_code,
                error: None,
            },
            Err(e) if e.is::<auth::Cancelled>() => SshEvent::Closed {
                exit_code: None,
                error: None,
            },
            Err(e) => SshEvent::Closed {
                exit_code: None,
                error: Some(format!("{e:#}")),
            },
        };
        let _ = on_event.send(event);
    });

    Ok(id)
}

async fn wait_cancelled(mut cancel: watch::Receiver<bool>) {
    let _ = cancel.wait_for(|cancelled| *cancelled).await;
}

/// Everything needed to open an authenticated SSH connection to a saved host. Shared by
/// terminal sessions and SFTP.
pub struct Connector {
    pub host: Host,
    pub known_hosts: PathBuf,
    pub prompter: Prompter,
    pub save_secret: Arc<SecretSaver>,
}

impl Connector {
    /// TCP connect, key exchange (with host key check) and user authentication.
    pub async fn connect(&self) -> Result<client::Handle<ClientHandler>> {
        let host = &self.host;
        self.prompter.notify(SshEvent::Status {
            stage: Stage::Connecting,
        });

        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            ..Default::default()
        });
        let handler = ClientHandler {
            host: host.hostname.clone(),
            port: host.port,
            known_hosts: self.known_hosts.clone(),
            prompter: self.prompter.clone(),
        };
        // Only the TCP connection is timed: the key exchange below can wait on the user
        // reading a host key prompt.
        let address = (host.hostname.as_str(), host.port);
        let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address))
            .await
            .with_context(|| format!("timed out connecting to {}:{}", host.hostname, host.port))?
            .with_context(|| format!("could not connect to {}:{}", host.hostname, host.port))?;
        stream.set_nodelay(true)?;
        let mut handle = client::connect_stream(config, stream, handler).await?;

        self.prompter.notify(SshEvent::Status {
            stage: Stage::Authenticating,
        });
        let ctx = auth::AuthContext {
            host,
            prompter: &self.prompter,
            save_secret: &*self.save_secret,
        };
        auth::authenticate(&mut handle, &ctx).await?;
        Ok(handle)
    }

    /// Builds a connector for a saved host, wired to the app's keychain and host store.
    pub fn for_host(
        app: &AppHandle,
        host_id: &str,
        on_event: &Channel<SshEvent>,
        registry: &Arc<PromptRegistry>,
    ) -> Result<Self, String> {
        let host = app
            .state::<HostStore>()
            .get(app, host_id)?
            .ok_or("host not found")?;
        let save_secret: Arc<SecretSaver> = {
            let (app, host_id) = (app.clone(), host.id.clone());
            Arc::new(move |kind, value| {
                secrets::set(&host_id, kind, value)?;
                app.state::<HostStore>()
                    .mark_secret(&app, &host_id, kind, true)
            })
        };
        Ok(Self {
            host,
            known_hosts: crate::known_hosts_admin::app_file(app)?,
            prompter: Prompter {
                events: on_event.clone(),
                registry: registry.clone(),
            },
            save_secret,
        })
    }
}

struct Session {
    connector: Connector,
    cols: u32,
    rows: u32,
}

impl Session {
    /// Returns the remote shell's exit code, if it sent one.
    async fn run(
        self,
        mut commands: mpsc::UnboundedReceiver<Command>,
        on_data: Channel<InvokeResponseBody>,
        on_monitor: Channel<MonitorEvent>,
    ) -> Result<Option<u32>> {
        // Shared with the commands the assistant runs on their own channels.
        let handle = Arc::new(self.connector.connect().await?);

        let mut channel = handle.channel_open_session().await?;
        channel
            .request_pty(false, "xterm-256color", self.cols, self.rows, 0, 0, &[])
            .await?;
        channel.request_shell(true).await?;
        self.connector.prompter.notify(SshEvent::Status {
            stage: Stage::Connected,
        });

        match handle.channel_open_session().await {
            Ok(monitor_channel) => {
                tauri::async_runtime::spawn(monitor::run(monitor_channel, on_monitor));
            }
            Err(_) => {
                let _ = on_monitor.send(MonitorEvent::Unsupported);
            }
        }

        // Runs alongside the session, so a slow server never holds up the terminal.
        let detect_os = os::detect(&handle);
        tokio::pin!(detect_os);
        let mut detecting = true;

        let mut exit_code = None;
        loop {
            tokio::select! {
                detected = &mut detect_os, if detecting => {
                    detecting = false;
                    if let Some(os) = detected {
                        self.connector.prompter.notify(SshEvent::Os { os });
                    }
                }
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if on_data.send(InvokeResponseBody::Raw(data.to_vec())).is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                    Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                },
                command = commands.recv() => match command {
                    Some(Command::Data(data)) => channel.data_bytes(data).await?,
                    Some(Command::Resize { cols, rows }) => channel.window_change(cols, rows, 0, 0).await?,
                    Some(Command::Exec { command, timeout, reply }) => {
                        let handle = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = reply.send(crate::exec::ssh(&handle, &command, timeout).await);
                        });
                    }
                    Some(Command::Close) | None => {
                        let _ = channel.close().await;
                        break;
                    }
                },
            }
        }

        let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
        Ok(exit_code)
    }
}

/// Runs a command on the session's server, outside the user's shell (agent mode).
#[tauri::command]
pub async fn ssh_exec(
    state: State<'_, SshState>,
    id: u32,
    command: String,
    timeout_secs: u64,
) -> Result<crate::exec::ExecOutput, String> {
    let (reply, result) = tokio::sync::oneshot::channel();
    state.send(
        id,
        Command::Exec {
            command,
            timeout: Duration::from_secs(timeout_secs.clamp(1, 3600)),
            reply,
        },
    )?;
    result.await.map_err(|_| "the session closed".to_string())?
}

#[tauri::command]
pub fn ssh_write(state: State<'_, SshState>, id: u32, data: String) -> Result<(), String> {
    state.send(id, Command::Data(data.into_bytes()))
}

#[tauri::command]
pub fn ssh_resize(state: State<'_, SshState>, id: u32, cols: u32, rows: u32) -> Result<(), String> {
    state.send(id, Command::Resize { cols, rows })
}

#[tauri::command]
pub fn ssh_close(state: State<'_, SshState>, id: u32) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get(&id) {
        let _ = session.commands.send(Command::Close);
        // Also aborts a connection that is still waiting on the network or on a prompt.
        let _ = session.cancel.send(true);
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_close_all(state: State<'_, SshState>) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    for session in sessions.values() {
        let _ = session.cancel.send(true);
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_prompt_reply(
    registry: State<'_, Arc<PromptRegistry>>,
    request_id: u64,
    reply: PromptReply,
) -> Result<(), String> {
    registry.reply(request_id, reply)
}
