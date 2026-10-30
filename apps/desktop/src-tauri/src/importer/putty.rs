//! PuTTY (and KiTTY) sessions: a `.reg` export of `HKCU\Software\SimonTatham\PuTTY\Sessions`
//! (on Windows the registry itself is read through such an export), or the `~/.putty/sessions`
//! directory on Linux and macOS. Only SSH sessions are imported.

use std::collections::HashMap;
use std::path::Path;

use super::{ImportedHost, Parsed};
use crate::hosts::Protocol;

/// Session names are stored URL-encoded (`My%20server`).
fn decode_name(name: &str) -> String {
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(byte) = name
                .get(i + 1..i + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One session from its settings, or why it was left out.
fn session(name: &str, settings: &HashMap<String, String>) -> Result<Option<ImportedHost>, String> {
    if name == "Default Settings" {
        return Ok(None);
    }
    let protocol = settings
        .get("Protocol")
        .map(String::as_str)
        .unwrap_or("ssh");
    if protocol != "ssh" {
        return Err(format!("{name}: {protocol} sessions are not supported"));
    }
    let Some(address) = settings.get("HostName").filter(|h| !h.is_empty()) else {
        return Ok(None);
    };
    // `user@host` is allowed in the host name field.
    let (user_in_host, hostname) = match address.rsplit_once('@') {
        Some((user, host)) => (Some(user.to_string()), host.to_string()),
        None => (None, address.clone()),
    };
    let key_path = settings
        .get("PublicKeyFile")
        .filter(|k| !k.is_empty())
        .cloned();
    Ok(Some(ImportedHost {
        name: name.to_string(),
        hostname,
        port: settings
            .get("PortNumber")
            .and_then(|p| p.parse().ok())
            .unwrap_or(22),
        username: settings
            .get("UserName")
            .filter(|u| !u.is_empty())
            .cloned()
            .or(user_in_host)
            .unwrap_or_default(),
        protocol: Protocol::Ssh,
        key_path,
        ..ImportedHost::default()
    }))
}

fn collect(sessions: Vec<(String, HashMap<String, String>)>) -> Parsed {
    let mut parsed = Parsed::default();
    for (name, settings) in sessions {
        match session(&name, &settings) {
            Ok(Some(host)) => parsed.hosts.push(host),
            Ok(None) => {}
            Err(warning) => parsed.warnings.push(warning),
        }
    }
    if parsed.hosts.iter().any(|h| {
        h.key_path
            .as_deref()
            .is_some_and(|k| k.to_ascii_lowercase().ends_with(".ppk"))
    }) {
        parsed.warnings.push(
            "PuTTY .ppk keys must be converted to OpenSSH format (PuTTYgen → Conversions → Export OpenSSH key)".into(),
        );
    }
    parsed
}

/// A `.reg` string value: `"C:\\keys\\a.ppk"` → `C:\keys\a.ppk`.
fn reg_string(value: &str) -> Option<String> {
    let inner = value.strip_prefix('"')?.strip_suffix('"')?;
    Some(
        inner
            .replace("\\\\", "\u{0}")
            .replace("\\\"", "\"")
            .replace('\u{0}', "\\"),
    )
}

pub fn parse_reg(text: &str) -> Parsed {
    let mut sessions: Vec<(String, HashMap<String, String>)> = Vec::new();
    for line in text.lines().map(str::trim) {
        if let Some(key) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            if let Some((_, name)) = key.split_once("\\Sessions\\") {
                sessions.push((decode_name(name), HashMap::new()));
            }
            continue;
        }
        let (Some((_, settings)), Some((name, value))) =
            (sessions.last_mut(), line.split_once('='))
        else {
            continue;
        };
        let Some(name) = reg_string(name) else {
            continue;
        };
        let value = match value.strip_prefix("dword:") {
            Some(hex) => u32::from_str_radix(hex, 16).map(|n| n.to_string()).ok(),
            None => reg_string(value),
        };
        if let Some(value) = value {
            settings.insert(name, value);
        }
    }
    collect(sessions)
}

pub fn parse_dir(dir: &Path) -> Result<Parsed, String> {
    let mut sessions = Vec::new();
    for entry in std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
    {
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let settings = text
            .lines()
            .filter_map(|line| line.split_once('='))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        sessions.push((decode_name(&entry.file_name().to_string_lossy()), settings));
    }
    sessions.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(collect(sessions))
}

/// The sessions in the Windows registry, exported with `reg export`.
#[cfg(windows)]
pub fn from_registry() -> Option<Parsed> {
    let file = std::env::temp_dir().join(format!("hostealo-putty-{}.reg", std::process::id()));
    use std::os::windows::process::CommandExt;
    let status = std::process::Command::new("reg")
        .creation_flags(crate::exec::CREATE_NO_WINDOW)
        .args(["export", r"HKCU\Software\SimonTatham\PuTTY\Sessions"])
        .arg(&file)
        .arg("/y")
        .status()
        .ok()?;
    let text = status
        .success()
        .then(|| super::read_text(&file).ok())
        .flatten();
    let _ = std::fs::remove_file(&file);
    text.map(|text| parse_reg(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_registry_export() {
        let reg = r#"Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions]

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\Default%20Settings]
"HostName"=""

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\Producci%C3%B3n%20web]
"HostName"="deploy@203.0.113.10"
"PortNumber"=dword:00000016
"Protocol"="ssh"
"PublicKeyFile"="C:\\Users\\ana\\keys\\web.ppk"

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\router]
"HostName"="192.168.1.1"
"Protocol"="telnet"
"#;
        let parsed = parse_reg(reg);
        assert_eq!(parsed.hosts.len(), 1);
        let host = &parsed.hosts[0];
        assert_eq!(
            (
                host.name.as_str(),
                host.hostname.as_str(),
                host.port,
                host.username.as_str()
            ),
            ("Producción web", "203.0.113.10", 22, "deploy")
        );
        assert_eq!(host.key_path.as_deref(), Some(r"C:\Users\ana\keys\web.ppk"));
        assert!(parsed.warnings.iter().any(|w| w.contains("telnet")));
        assert!(parsed.warnings.iter().any(|w| w.contains(".ppk")));
    }

    #[test]
    fn reads_the_sessions_directory() {
        let dir = std::env::temp_dir().join(format!("ht-putty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("lab%20pi"),
            "HostName=192.168.1.30\nPortNumber=2222\nUserName=pi\nProtocol=ssh\n",
        )
        .unwrap();
        let parsed = parse_dir(&dir).unwrap();
        assert_eq!(
            (
                parsed.hosts[0].name.as_str(),
                parsed.hosts[0].port,
                parsed.hosts[0].username.as_str()
            ),
            ("lab pi", 2222, "pi")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
