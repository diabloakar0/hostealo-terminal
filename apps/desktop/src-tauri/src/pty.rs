//! Local shell sessions (desktop only).
//!
//! Output is streamed to the webview as raw bytes over a Tauri channel; xterm.js decodes UTF-8
//! itself, so a multi-byte character split across two reads is handled correctly.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: AtomicU32,
}

impl PtyState {
    fn remove(&self, id: u32) -> Option<PtySession> {
        self.sessions.lock().ok()?.remove(&id)
    }
}

fn shell_command() -> CommandBuilder {
    let mut cmd = if cfg!(windows) {
        CommandBuilder::new("powershell.exe")
    } else {
        // Uses $SHELL and starts it as a login shell, so the user's profile is loaded.
        CommandBuilder::new_default_prog()
    };

    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    if let Some(home) = home {
        cmd.cwd(home);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "HostealoTerminal");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // Apps launched from Finder/Dock get no locale, which breaks UTF-8 in zsh and friends.
    if std::env::var_os("LANG").is_none() && !cfg!(windows) {
        cmd.env("LANG", "en_US.UTF-8");
    }
    cmd
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<Option<u32>>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let child = pair
        .slave
        .spawn_command(shell_command())
        .map_err(|e| e.to_string())?;
    // The slave end must be closed here, otherwise reads never hit EOF when the shell exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.sessions.lock().map_err(|e| e.to_string())?.insert(
        id,
        PtySession {
            writer,
            master: pair.master,
            child,
        },
    );

    std::thread::Builder::new()
        .name(format!("pty-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if on_data
                            .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            // `None` when the session was already removed by `pty_kill`.
            let exit_code = app
                .state::<PtyState>()
                .remove(id)
                .and_then(|mut s| s.child.wait().ok())
                .map(|status| status.exit_code());
            let _ = on_exit.send(exit_code);
        })
        .map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    if let Some(mut session) = state.remove(id) {
        session.child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Called when the UI boots: after a webview reload the old tabs are gone, but their shells
/// would otherwise keep running with nobody attached.
#[tauri::command]
pub fn pty_kill_all(state: State<'_, PtyState>) -> Result<(), String> {
    let sessions: Vec<PtySession> = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .drain()
        .map(|(_, s)| s)
        .collect();
    for mut session in sessions {
        let _ = session.child.kill();
    }
    Ok(())
}
