//! Listing and cleaning known host keys, in the app's own file and in `~/.ssh/known_hosts`.
//!
//! Typical use: a server was reinstalled with the same IP, so its old key must be forgotten.
//! Before the user's `~/.ssh/known_hosts` is changed, a copy is kept as `known_hosts.old`
//! (as `ssh-keygen -R` does).

use std::path::{Path, PathBuf};

use data_encoding::BASE64;
use hmac::{Hmac, KeyInit, Mac};
use russh::keys::{HashAlg, ssh_key::PublicKey};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// Keys trusted from Hostealo Terminal.
    App,
    /// The user's OpenSSH file.
    User,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub source: Source,
    /// 1-based physical line number.
    pub line: usize,
    /// The whole line, so a removal can check the file has not changed meanwhile.
    pub raw: String,
    /// Host patterns; empty for hashed entries, whose names cannot be shown.
    pub hosts: Vec<String>,
    pub hashed: bool,
    /// `@cert-authority` or `@revoked`.
    pub marker: Option<String>,
    pub key_type: String,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRef {
    pub source: Source,
    pub line: usize,
    pub raw: String,
}

pub fn app_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("known_hosts"))
}

pub fn user_file() -> Option<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(Path::new(&home).join(".ssh").join("known_hosts"))
}

struct Parsed<'a> {
    marker: Option<&'a str>,
    hosts: &'a str,
    key_type: &'a str,
    key_data: &'a str,
}

fn parse_line(line: &str) -> Option<Parsed<'_>> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let mut fields = line.split_whitespace();
    let mut first = fields.next()?;
    let marker = if first.starts_with('@') {
        let marker = first;
        first = fields.next()?;
        Some(marker)
    } else {
        None
    };
    Some(Parsed {
        marker,
        hosts: first,
        key_type: fields.next()?,
        key_data: fields.next()?,
    })
}

/// `host` or `[host]:port`, the way OpenSSH writes hosts in known_hosts.
fn host_token(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// Splits user input such as `1.2.3.4`, `1.2.3.4:2222` or `[1.2.3.4]:2222` into host and port.
fn parse_target(query: &str) -> (String, u16) {
    let query = query.trim();
    if let Some(rest) = query.strip_prefix('[')
        && let Some((host, port)) = rest.split_once("]:")
        && let Ok(port) = port.parse()
    {
        return (host.to_string(), port);
    }
    match query.rsplit_once(':') {
        // A single colon: host:port. More than one is an IPv6 address.
        Some((host, port)) if !host.contains(':') => match port.parse() {
            Ok(port) => (host.to_string(), port),
            Err(_) => (query.to_string(), 22),
        },
        _ => (query.to_string(), 22),
    }
}

fn hashed_matches(pattern: &str, token: &str) -> bool {
    let mut parts = pattern.split('|').skip(2);
    let (Some(salt), Some(hash)) = (parts.next(), parts.next()) else {
        return false;
    };
    let (Ok(salt), Ok(hash)) = (
        BASE64.decode(salt.as_bytes()),
        BASE64.decode(hash.as_bytes()),
    ) else {
        return false;
    };
    let Ok(mac) = Hmac::<Sha1>::new_from_slice(&salt) else {
        return false;
    };
    mac.chain_update(token.as_bytes())
        .verify_slice(&hash)
        .is_ok()
}

fn glob_matches(pattern: &str, text: &str) -> bool {
    fn go(p: &[u8], t: &[u8]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some(b'*'), _) => go(&p[1..], t) || (!t.is_empty() && go(p, &t[1..])),
            (Some(b'?'), Some(_)) => go(&p[1..], &t[1..]),
            (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => go(&p[1..], &t[1..]),
            _ => false,
        }
    }
    go(pattern.as_bytes(), text.as_bytes())
}

/// Whether a known_hosts host field applies to exactly `host:port` (as OpenSSH would decide).
fn entry_matches_host(hosts_field: &str, host: &str, port: u16) -> bool {
    let token = host_token(host, port);
    let mut matched = false;
    for pattern in hosts_field.split(',') {
        if let Some(negated) = pattern.strip_prefix('!') {
            if glob_matches(negated, &token) {
                return false;
            }
        } else if pattern.starts_with("|1|") {
            matched |= hashed_matches(pattern, &token);
        } else {
            matched |= glob_matches(pattern, &token);
        }
    }
    matched
}

/// Search: a substring of a visible host name, or the exact host of a hashed entry.
fn entry_matches_query(parsed: &Parsed<'_>, query: &str) -> bool {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return true;
    }
    let visible = parsed
        .hosts
        .split(',')
        .filter(|p| !p.starts_with("|1|"))
        .any(|p| p.to_lowercase().contains(&needle));
    let (host, port) = parse_target(query);
    visible || entry_matches_host(parsed.hosts, &host, port)
}

fn read_entries(path: &Path, source: Source, query: Option<&str>) -> Vec<KnownHostEntry> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    content
        .lines()
        .enumerate()
        .filter_map(|(index, raw)| {
            let parsed = parse_line(raw)?;
            if let Some(query) = query
                && !entry_matches_query(&parsed, query)
            {
                return None;
            }
            let hashed = parsed.hosts.starts_with("|1|");
            let fingerprint =
                PublicKey::from_openssh(&format!("{} {}", parsed.key_type, parsed.key_data))
                    .ok()
                    .map(|key| key.fingerprint(HashAlg::Sha256).to_string());
            Some(KnownHostEntry {
                source,
                line: index + 1,
                raw: raw.to_string(),
                hosts: if hashed {
                    Vec::new()
                } else {
                    parsed.hosts.split(',').map(String::from).collect()
                },
                hashed,
                marker: parsed.marker.map(String::from),
                key_type: parsed.key_type.to_string(),
                fingerprint,
            })
        })
        .collect()
}

/// Rewrites `path` without the lines for which `remove(line_number, line)` is true.
/// Returns how many lines were removed. The user's file is backed up first.
fn rewrite(
    path: &Path,
    source: Source,
    remove: impl Fn(usize, &str) -> bool,
) -> Result<usize, String> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.to_string()),
    };
    let mut removed = 0;
    let mut kept = String::with_capacity(content.len());
    for (index, line) in content.lines().enumerate() {
        if remove(index + 1, line) {
            removed += 1;
        } else {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    if removed == 0 {
        return Ok(0);
    }
    if source == Source::User {
        std::fs::copy(path, path.with_extension("old"))
            .map_err(|e| format!("could not back up {}: {e}", path.display()))?;
    }
    std::fs::write(path, kept).map_err(|e| e.to_string())?;
    Ok(removed)
}

fn files(app: &AppHandle) -> Result<Vec<(PathBuf, Source)>, String> {
    let mut files = vec![(app_file(app)?, Source::App)];
    if let Some(user) = user_file() {
        files.push((user, Source::User));
    }
    Ok(files)
}

#[tauri::command]
pub fn known_hosts_list(
    app: AppHandle,
    query: Option<String>,
) -> Result<Vec<KnownHostEntry>, String> {
    let query = query.as_deref().filter(|q| !q.trim().is_empty());
    Ok(files(&app)?
        .into_iter()
        .flat_map(|(path, source)| read_entries(&path, source, query))
        .collect())
}

/// Removes the given entries. An entry whose line changed since it was listed is skipped.
#[tauri::command]
pub fn known_hosts_remove(app: AppHandle, entries: Vec<EntryRef>) -> Result<usize, String> {
    let mut removed = 0;
    for (path, source) in files(&app)? {
        let targets: Vec<&EntryRef> = entries.iter().filter(|e| e.source == source).collect();
        if !targets.is_empty() {
            removed += rewrite(&path, source, |number, line| {
                targets.iter().any(|t| t.line == number && t.raw == line)
            })?;
        }
    }
    Ok(removed)
}

/// Forgets every key recorded for `host` (`host`, `host:port` or `[host]:port`), hashed or not.
#[tauri::command]
pub fn known_hosts_forget(app: AppHandle, target: String) -> Result<usize, String> {
    let (host, port) = parse_target(&target);
    if host.is_empty() {
        return Err("empty host".into());
    }
    let mut removed = 0;
    for (path, source) in files(&app)? {
        removed += rewrite(&path, source, |_, line| {
            parse_line(line).is_some_and(|parsed| entry_matches_host(parsed.hosts, &host, port))
        })?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

    fn hashed(token: &str) -> String {
        let salt = b"0123456789abcdef0123";
        let mac = Hmac::<Sha1>::new_from_slice(salt)
            .unwrap()
            .chain_update(token.as_bytes())
            .finalize();
        format!(
            "|1|{}|{}",
            BASE64.encode(salt),
            BASE64.encode(&mac.into_bytes())
        )
    }

    #[test]
    fn targets_are_parsed() {
        assert_eq!(parse_target("1.2.3.4"), ("1.2.3.4".into(), 22));
        assert_eq!(parse_target("1.2.3.4:2222"), ("1.2.3.4".into(), 2222));
        assert_eq!(parse_target("[1.2.3.4]:2222"), ("1.2.3.4".into(), 2222));
        assert_eq!(parse_target("2001:db8::1"), ("2001:db8::1".into(), 22));
        assert_eq!(parse_target("[2001:db8::1]:22"), ("2001:db8::1".into(), 22));
    }

    #[test]
    fn hosts_match_like_openssh() {
        assert!(entry_matches_host("web,1.2.3.4", "1.2.3.4", 22));
        assert!(!entry_matches_host("1.2.3.4", "1.2.3.4", 2222));
        assert!(entry_matches_host("[1.2.3.4]:2222", "1.2.3.4", 2222));
        assert!(entry_matches_host(
            "*.example.com,!bad.example.com",
            "a.example.com",
            22
        ));
        assert!(!entry_matches_host(
            "*.example.com,!bad.example.com",
            "bad.example.com",
            22
        ));
        assert!(entry_matches_host(&hashed("1.2.3.4"), "1.2.3.4", 22));
        assert!(entry_matches_host(
            &hashed("[1.2.3.4]:2222"),
            "1.2.3.4",
            2222
        ));
        assert!(!entry_matches_host(&hashed("1.2.3.4"), "1.2.3.5", 22));
    }

    #[test]
    fn list_search_and_forget() {
        let dir = std::env::temp_dir().join(format!("ht-kh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("known_hosts");
        let content = format!(
            "# comment\n1.2.3.4 ssh-ed25519 {KEY}\n{} ssh-ed25519 {KEY}\n[1.2.3.4]:2222 ssh-ed25519 {KEY}\nother.host ssh-ed25519 {KEY}\n@cert-authority *.corp ssh-ed25519 {KEY}\n",
            hashed("1.2.3.4")
        );
        std::fs::write(&path, &content).unwrap();

        let all = read_entries(&path, Source::User, None);
        assert_eq!(all.len(), 5);
        assert_eq!(all[0].line, 2);
        assert!(
            all[0]
                .fingerprint
                .as_deref()
                .unwrap()
                .starts_with("SHA256:")
        );
        assert!(all[1].hashed && all[1].hosts.is_empty());
        assert_eq!(all[4].marker.as_deref(), Some("@cert-authority"));

        // The search finds the plain entries by substring and the hashed one by exact host.
        let found = read_entries(&path, Source::User, Some("1.2.3.4"));
        assert_eq!(found.iter().map(|e| e.line).collect::<Vec<_>>(), [2, 3, 4]);

        // Forgetting port 22 keeps the [1.2.3.4]:2222 entry, and backs the file up.
        let removed = rewrite(&path, Source::User, |_, line| {
            parse_line(line).is_some_and(|p| entry_matches_host(p.hosts, "1.2.3.4", 22))
        })
        .unwrap();
        assert_eq!(removed, 2);
        let left = std::fs::read_to_string(&path).unwrap();
        assert!(left.starts_with("# comment\n[1.2.3.4]:2222 "), "{left}");
        assert_eq!(
            std::fs::read_to_string(path.with_extension("old")).unwrap(),
            content
        );

        // Removing by reference skips a line whose content no longer matches.
        let entries = read_entries(&path, Source::User, Some("other"));
        let stale = EntryRef {
            source: Source::User,
            line: entries[0].line,
            raw: "changed".into(),
        };
        assert_eq!(
            rewrite(&path, Source::User, |n, l| n == stale.line
                && l == stale.raw)
            .unwrap(),
            0
        );
        let fresh = &entries[0];
        assert_eq!(
            rewrite(&path, Source::User, |n, l| n == fresh.line
                && l == fresh.raw)
            .unwrap(),
            1
        );
    }
}
