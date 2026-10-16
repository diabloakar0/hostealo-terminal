//! OpenSSH's `~/.ssh/config`: each `Host` alias without wildcards is a connection. Options are
//! resolved like `ssh` does: the first value found in the blocks that match the alias wins, so
//! `Host *` defaults at the end apply too. `Include` is followed.

use std::path::Path;

use super::{ImportedHost, Parsed};
use crate::hosts::Protocol;

/// Includes nested deeper than this are ignored (they would be loops).
const MAX_DEPTH: usize = 8;

pub fn looks_like(text: &str) -> bool {
    !text.trim_start().starts_with('<')
        && text.lines().any(|line| {
            let line = line.trim().to_ascii_lowercase();
            line.starts_with("host ") || line.starts_with("host=") || line.starts_with("host\t")
        })
}

struct Block {
    patterns: Vec<String>,
    options: Vec<(String, String)>,
}

/// `Key value`, `Key=value` or `Key = value`; the key in lower case, quotes removed.
fn split_option(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let (key, rest) = line.split_at(end);
    let value = rest.trim_start().trim_start_matches('=').trim();
    Some((
        key.to_ascii_lowercase(),
        value.trim_matches('"').to_string(),
    ))
}

fn glob(pattern: &str, text: &str) -> bool {
    fn matches(p: &[char], t: &[char]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some('*'), _) => matches(&p[1..], t) || (!t.is_empty() && matches(p, &t[1..])),
            (Some('?'), Some(_)) => matches(&p[1..], &t[1..]),
            (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => matches(&p[1..], &t[1..]),
            _ => false,
        }
    }
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    matches(&p, &t)
}

/// `Host` patterns: one negated match excludes, otherwise any positive match includes.
fn block_matches(patterns: &[String], alias: &str) -> bool {
    let mut matched = false;
    for pattern in patterns {
        match pattern.strip_prefix('!') {
            Some(negated) if glob(negated, alias) => return false,
            Some(_) => {}
            None => matched |= glob(pattern, alias),
        }
    }
    matched
}

fn read_blocks(text: &str, base: &Path, depth: usize, blocks: &mut Vec<Block>) {
    for line in text.lines() {
        let Some((key, value)) = split_option(line) else {
            continue;
        };
        match key.as_str() {
            "host" => blocks.push(Block {
                patterns: value
                    .split_whitespace()
                    .map(|p| p.trim_matches('"').to_string())
                    .collect(),
                options: Vec::new(),
            }),
            // Conditions this importer can't evaluate: the block is left out.
            "match" => blocks.push(Block {
                patterns: Vec::new(),
                options: Vec::new(),
            }),
            "include" if depth < MAX_DEPTH => {
                for pattern in value.split_whitespace() {
                    for path in include_paths(pattern, base) {
                        if let Ok(text) = std::fs::read_to_string(&path) {
                            read_blocks(&text, base, depth + 1, blocks);
                        }
                    }
                }
            }
            _ => match blocks.last_mut() {
                Some(block) => block.options.push((key, value)),
                // Before any `Host`: applies to every host.
                None => blocks.push(Block {
                    patterns: vec!["*".into()],
                    options: vec![(key, value)],
                }),
            },
        }
    }
}

/// An `Include` argument: relative to `~/.ssh`, `~` expanded, `*` allowed in the file name.
fn include_paths(pattern: &str, base: &Path) -> Vec<std::path::PathBuf> {
    let expanded = match pattern.strip_prefix("~/") {
        Some(rest) => std::env::var_os("HOME").map(|home| Path::new(&home).join(rest)),
        None => Some(base.join(pattern)),
    };
    let Some(path) = expanded else {
        return Vec::new();
    };
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    let mut found: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| glob(&name, n))
        })
        .collect();
    found.sort();
    found
}

pub fn parse(text: &str, base: &Path) -> Parsed {
    let mut blocks = Vec::new();
    let mut parsed = Parsed::default();
    read_blocks(text, base, 0, &mut blocks);

    let mut aliases: Vec<String> = Vec::new();
    for block in &blocks {
        for pattern in &block.patterns {
            if !pattern.contains(['*', '?', '!']) && !aliases.contains(pattern) {
                aliases.push(pattern.clone());
            }
        }
    }
    for alias in aliases {
        let option = |key: &str| {
            blocks
                .iter()
                .filter(|block| block_matches(&block.patterns, &alias))
                .find_map(|block| {
                    block
                        .options
                        .iter()
                        .find(|(k, _)| k == key)
                        .map(|(_, v)| v.clone())
                })
        };
        let hostname =
            option("hostname").map_or_else(|| alias.clone(), |h| h.replace("%h", &alias));
        if option("proxyjump").is_some() || option("proxycommand").is_some() {
            parsed.warnings.push(format!(
                "{alias}: goes through a jump host, which is not supported yet"
            ));
        }
        parsed.hosts.push(ImportedHost {
            name: alias.clone(),
            hostname,
            port: option("port").and_then(|p| p.parse().ok()).unwrap_or(22),
            username: option("user").unwrap_or_default(),
            protocol: Protocol::Ssh,
            key_path: option("identityfile"),
            ..ImportedHost::default()
        });
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_get_their_options_and_the_wildcard_defaults() {
        let config = "\
# Mis servidores
Host web-01 web
    HostName 203.0.113.10
    User root
    IdentityFile \"~/.ssh/id_ed25519\"

Host db
  hostname=db.internal
  Port 2222

Host *.lab !secret.lab
    User admin

Match host foo
    User nobody

Host *
    User deploy
    Port 22
";
        let parsed = parse(config, Path::new("/nonexistent"));
        let summary: Vec<_> = parsed
            .hosts
            .iter()
            .map(|h| {
                (
                    h.name.as_str(),
                    h.hostname.as_str(),
                    h.port,
                    h.username.as_str(),
                    h.key_path.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                (
                    "web-01",
                    "203.0.113.10",
                    22,
                    "root",
                    Some("~/.ssh/id_ed25519")
                ),
                ("web", "203.0.113.10", 22, "root", Some("~/.ssh/id_ed25519")),
                ("db", "db.internal", 2222, "deploy", None),
            ]
        );
        assert!(looks_like(config));
        assert!(!looks_like("<?xml version=\"1.0\"?><FileZilla3/>"));
    }

    #[test]
    fn includes_are_followed() {
        let dir = std::env::temp_dir().join(format!("ht-sshconfig-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("config.d")).unwrap();
        std::fs::write(
            dir.join("config.d/clientes.conf"),
            "Host acme\n  HostName 198.51.100.20\n",
        )
        .unwrap();
        let parsed = parse("Include config.d/*.conf\nHost local\n", &dir);
        let names: Vec<_> = parsed.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["acme", "local"]);
        assert_eq!(parsed.hosts[0].hostname, "198.51.100.20");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn negated_patterns_exclude() {
        assert!(block_matches(
            &["*.lab".into(), "!secret.lab".into()],
            "web.lab"
        ));
        assert!(!block_matches(
            &["*.lab".into(), "!secret.lab".into()],
            "secret.lab"
        ));
        assert!(glob("web-??", "web-01") && !glob("web-?", "web-01"));
    }
}
