//! Secrets (passwords, key passphrases) live in the OS credential store only:
//! Keychain on macOS/iOS, Credential Manager on Windows, Secret Service on Linux.
//! They are never written to disk by the app and never sent to the webview.

use crate::keystore::{self, Error};

const SERVICE: &str = "es.hostealo.terminal";

#[derive(Debug, Clone, Copy)]
pub enum SecretKind {
    Password,
    Passphrase,
}

fn account(host_id: &str, kind: SecretKind) -> String {
    let suffix = match kind {
        SecretKind::Password => "password",
        SecretKind::Passphrase => "passphrase",
    };
    format!("host:{host_id}:{suffix}")
}

pub fn set(host_id: &str, kind: SecretKind, value: &str) -> Result<(), String> {
    keystore::entry(SERVICE, &account(host_id, kind))
        .and_then(|e| e.set_password(value))
        .map_err(|e| format!("could not save to the system keychain: {e}"))
}

/// `Ok(None)` when nothing is stored.
pub fn get(host_id: &str, kind: SecretKind) -> Result<Option<String>, String> {
    match keystore::entry(SERVICE, &account(host_id, kind)).and_then(|e| e.get_password()) {
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read from the system keychain: {e}")),
    }
}

pub fn delete(host_id: &str, kind: SecretKind) -> Result<(), String> {
    match keystore::entry(SERVICE, &account(host_id, kind)).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not delete from the system keychain: {e}")),
    }
}
