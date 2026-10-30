//! Runs one command to completion and collects what it printed: on an SSH server through its own
//! exec channel (so it never mixes with the user's shell), or on this computer. Used by the AI
//! assistant's agent mode, only for commands the user approved.
//!
//! Commands run without a terminal and with stdin closed: anything that waits for input gets
//! end-of-file instead of hanging, and a timeout ends whatever still runs.

use std::time::Duration;

use russh::ChannelMsg;
use russh::client::Handle;
use serde::Serialize;

use crate::ssh::ClientHandler;

/// Output kept per stream (the end of it, where errors and results usually are).
const MAX_OUTPUT: usize = 64 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
    pub timed_out: bool,
}

/// Output kept for tools that read the whole of it (Docker listings, logs).
pub const LARGE_OUTPUT: usize = 8 * 1024 * 1024;

/// Keeps the last `max` bytes.
fn push_tail(buffer: &mut Vec<u8>, data: &[u8], max: usize) {
    buffer.extend_from_slice(data);
    if buffer.len() > max {
        buffer.drain(..buffer.len() - max);
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Runs `command` on the server of an open SSH connection.
pub async fn ssh(
    handle: &Handle<ClientHandler>,
    command: &str,
    timeout: Duration,
) -> Result<ExecOutput, String> {
    ssh_limited(handle, command, timeout, MAX_OUTPUT).await
}

/// Like `ssh`, keeping up to `max` bytes of each stream.
pub async fn ssh_limited(
    handle: &Handle<ClientHandler>,
    command: &str,
    timeout: Duration,
    max: usize,
) -> Result<ExecOutput, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .exec(true, command)
        .await
        .map_err(|e| e.to_string())?;
    channel.eof().await.map_err(|e| e.to_string())?;
    let (mut stdout, mut stderr, mut exit_code) = (Vec::new(), Vec::new(), None);
    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => push_tail(&mut stdout, &data, max),
                ChannelMsg::ExtendedData { data, .. } => push_tail(&mut stderr, &data, max),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    let timed_out = tokio::time::timeout(timeout, read).await.is_err();
    if timed_out {
        let _ = channel.close().await;
    }
    Ok(ExecOutput {
        stdout: text(&stdout),
        stderr: text(&stderr),
        exit_code,
        timed_out,
    })
}

/// Windows: console programs the app starts in the background (`cmd`, the AI provider's CLI, `reg`) get no
/// window of their own; without it each one flashes a console on screen.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Runs `command` on this computer, in the user's home folder.
pub async fn local(command: &str, timeout: Duration) -> Result<ExecOutput, String> {
    let mut process = if cfg!(windows) {
        let mut process = tokio::process::Command::new("cmd");
        process.args(["/C", command]);
        #[cfg(windows)]
        process.creation_flags(CREATE_NO_WINDOW);
        process
    } else {
        let mut process = tokio::process::Command::new("sh");
        process.args(["-c", command]);
        process
    };
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        process.current_dir(home);
    }
    let child = process
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(output) => {
            let output = output.map_err(|e| e.to_string())?;
            let tail = |bytes: &[u8]| text(&bytes[bytes.len().saturating_sub(MAX_OUTPUT)..]);
            Ok(ExecOutput {
                stdout: tail(&output.stdout),
                stderr: tail(&output.stderr),
                exit_code: output.status.code().map(|c| c as u32),
                timed_out: false,
            })
        }
        // Dropping the child kills it.
        Err(_) => Ok(ExecOutput {
            timed_out: true,
            ..ExecOutput::default()
        }),
    }
}

/// Runs a command on this computer (the agent mode of a local terminal tab).
#[tauri::command]
pub async fn local_exec(command: String, timeout_secs: u64) -> Result<ExecOutput, String> {
    local(&command, Duration::from_secs(timeout_secs.clamp(1, 3600))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn local_commands_report_output_exit_code_and_timeouts() {
        let output = local("echo hola; echo fallo >&2; exit 3", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(
            (
                output.stdout.as_str(),
                output.stderr.as_str(),
                output.exit_code,
                output.timed_out
            ),
            ("hola\n", "fallo\n", Some(3), false)
        );
        // stdin is closed: a command waiting for input ends instead of hanging.
        assert_eq!(
            local("read answer; echo \"got:$answer\"", Duration::from_secs(5))
                .await
                .unwrap()
                .stdout,
            "got:\n"
        );
        assert!(
            local("sleep 5", Duration::from_millis(300))
                .await
                .unwrap()
                .timed_out
        );
    }

    #[test]
    fn long_output_keeps_its_end() {
        let mut buffer = Vec::new();
        push_tail(&mut buffer, &vec![b'a'; MAX_OUTPUT], MAX_OUTPUT);
        push_tail(&mut buffer, b"END", MAX_OUTPUT);
        assert_eq!(buffer.len(), MAX_OUTPUT);
        assert!(buffer.ends_with(b"aEND"));
    }
}
