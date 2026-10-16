//! Host key verification (trust on first use).
//!
//! The app keeps its own `known_hosts` (OpenSSH format) in the app data directory and also reads
//! the user's `~/.ssh/known_hosts`, so hosts already trusted with OpenSSH connect without a prompt.
//! Verification never modifies the user's file; cleaning it is done on request from the
//! known hosts page (`known_hosts_admin`).

use std::path::Path;

use russh::keys::{self, PublicKey};

#[derive(Debug, PartialEq, Eq)]
pub enum HostKeyStatus {
    Trusted,
    Unknown,
    /// A different key of the same type is on record: possible man-in-the-middle.
    Changed,
}

pub fn status(host: &str, port: u16, key: &PublicKey, own_file: &Path) -> HostKeyStatus {
    match keys::check_known_hosts_path(host, port, key, own_file) {
        Ok(true) => HostKeyStatus::Trusted,
        Err(keys::Error::KeyChanged { .. }) => HostKeyStatus::Changed,
        // Our own record wins: if it has an entry for this host, don't fall back.
        Ok(false) if has_entries(host, port, own_file) => HostKeyStatus::Unknown,
        _ => match keys::check_known_hosts(host, port, key) {
            Ok(true) => HostKeyStatus::Trusted,
            Err(keys::Error::KeyChanged { .. }) => HostKeyStatus::Changed,
            _ => HostKeyStatus::Unknown,
        },
    }
}

fn has_entries(host: &str, port: u16, file: &Path) -> bool {
    keys::known_hosts::known_host_keys_path(host, port, file)
        .is_ok_and(|entries| !entries.is_empty())
}

/// Records `key` as the trusted key for `host:port`, replacing any previous entry of the same type.
pub fn trust(host: &str, port: u16, key: &PublicKey, own_file: &Path) -> Result<(), String> {
    if let Ok(entries) = keys::known_hosts::known_host_keys_path(host, port, own_file) {
        let stale: Vec<usize> = entries
            .into_iter()
            .filter(|(_, recorded)| recorded.algorithm() == key.algorithm())
            .map(|(line, _)| line)
            .collect();
        if !stale.is_empty() {
            remove_lines(own_file, &stale)?;
        }
    }
    keys::known_hosts::learn_known_hosts_path(host, port, key, own_file).map_err(|e| e.to_string())
}

/// `lines` are numbered the way russh numbers them: 1-based, and comment lines are not counted.
fn remove_lines(file: &Path, lines: &[usize]) -> Result<(), String> {
    let content = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    let mut number = 0;
    let kept: Vec<&str> = content
        .lines()
        .filter(|line| {
            if line.starts_with('#') {
                return true;
            }
            number += 1;
            !lines.contains(&number)
        })
        .collect();
    let mut output = kept.join("\n");
    if !output.is_empty() {
        output.push('\n');
    }
    std::fs::write(file, output).map_err(|e| e.to_string())
}
