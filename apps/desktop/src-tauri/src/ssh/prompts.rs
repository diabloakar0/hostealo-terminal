//! Questions the SSH task needs the user to answer (unknown host key, password, 2FA code...).
//!
//! The task sends a `SshEvent` carrying a request id and waits; the UI shows a dialog and
//! answers through the `ssh_prompt_reply` command.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::oneshot;

use super::SshEvent;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptKind {
    Password,
    Passphrase,
    KeyboardInteractive,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptField {
    pub prompt: String,
    pub echo: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PromptReply {
    HostKey {
        accept: bool,
    },
    Answers {
        answers: Vec<String>,
        remember: bool,
    },
    Cancel,
}

#[derive(Default)]
pub struct PromptRegistry {
    pending: Mutex<HashMap<u64, oneshot::Sender<PromptReply>>>,
    next_id: AtomicU64,
}

impl PromptRegistry {
    pub fn reply(&self, request_id: u64, reply: PromptReply) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&request_id)
            .ok_or("prompt is no longer pending")?;
        // The session may have been closed meanwhile; nothing to do then.
        let _ = sender.send(reply);
        Ok(())
    }
}

/// Per-session handle used by the SSH task to ask questions.
#[derive(Clone)]
pub struct Prompter {
    pub events: Channel<SshEvent>,
    pub registry: Arc<PromptRegistry>,
}

impl Prompter {
    /// Sends the event built by `make_event` and waits for the user's reply.
    /// Returns `Cancel` if the UI went away without answering.
    pub async fn ask(&self, make_event: impl FnOnce(u64) -> SshEvent) -> PromptReply {
        let id = self.registry.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        match self.registry.pending.lock() {
            Ok(mut pending) => pending.insert(id, tx),
            Err(_) => return PromptReply::Cancel,
        };
        if self.events.send(make_event(id)).is_err() {
            self.forget(id);
            return PromptReply::Cancel;
        }
        let reply = rx.await.unwrap_or(PromptReply::Cancel);
        self.forget(id);
        reply
    }

    fn forget(&self, id: u64) {
        if let Ok(mut pending) = self.registry.pending.lock() {
            pending.remove(&id);
        }
    }

    pub fn notify(&self, event: SshEvent) {
        let _ = self.events.send(event);
    }
}
