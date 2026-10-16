//! MobaXterm sessions: an exported `.mxtsessions` file, or the `[Bookmarks*]` sections of
//! `MobaXterm.ini`. Each section is a folder (`SubRep=Clients\Acme`); every other line is a
//! session, `Name= #icon#type%host%port%user%...#terminal#...#colour`. The session type is the
//! first `%` field (the icon number changes between versions). Passwords live encrypted in
//! another section and are not read.
//!
//! Format: https://gist.github.com/Ruzgfpegk/ab597838e4abbe8de30d7224afd062ea

use super::{ImportedHost, Parsed, nearest_color};
use crate::hosts::Protocol;

/// MobaXterm's escapes for characters that would break its own format.
fn unescape(value: &str) -> String {
    value
        .replace("__PTVIRG__", ";")
        .replace("__DBLQUO__", "\"")
        .replace("__PIPE__", "|")
        .replace("__DIEZE__", "#")
        .replace("__PERCENT__", "%")
        .replace("__EQUAL__", "=")
}

/// `_CurrentDrive_:\keys\a.pem`, `_ProfileDir_\.ssh\id_rsa` → usable paths.
fn key_path(value: &str) -> Option<String> {
    let value = unescape(value.trim());
    if value.is_empty() {
        return None;
    }
    let path = value
        .replace("_CurrentDrive_:", "C:")
        .replace("_ProfileDir_", "~");
    // Inside the user's profile the key may well be copied over as is: use `/` there.
    Some(if path.starts_with('~') {
        path.replace('\\', "/")
    } else {
        path
    })
}

/// A Windows COLORREF (`0x00BBGGRR` as a decimal number), `-1` for none.
fn colour(value: &str) -> Option<String> {
    let value: i64 = value.trim().parse().ok()?;
    if value < 0 {
        return None;
    }
    let (r, g, b) = (
        (value & 0xFF) as u8,
        ((value >> 8) & 0xFF) as u8,
        ((value >> 16) & 0xFF) as u8,
    );
    nearest_color(r, g, b)
}

fn session(name: &str, value: &str, folder: Option<&str>, parsed: &mut Parsed) {
    let parts: Vec<&str> = value.split('#').collect();
    let Some(connection) = parts.get(2) else {
        return;
    };
    let fields: Vec<&str> = connection.split('%').collect();
    let field = |i: usize| {
        fields
            .get(i)
            .map(|f| unescape(f.trim()))
            .unwrap_or_default()
    };
    let (protocol, default_port, key_field) = match fields.first().copied() {
        Some("0") => (Protocol::Ssh, 22, Some(14)),
        Some("7") => (Protocol::Ssh, 22, Some(9)),
        Some("4") => (Protocol::Rdp, 3389, None),
        Some("6") => (Protocol::Ftp, 21, None),
        Some(kind) => {
            let kind = match kind {
                "1" => "Telnet",
                "2" => "Rsh",
                "3" => "XDMCP",
                "5" => "VNC",
                "8" => "Serial",
                "9" => "File",
                "10" => "Shell",
                "11" => "Browser",
                "12" => "Mosh",
                "13" => "AWS S3",
                "14" => "WSL",
                other => other,
            };
            parsed
                .warnings
                .push(format!("{name}: {kind} sessions are not supported"));
            return;
        }
        None => return,
    };
    let hostname = field(1);
    if hostname.is_empty() {
        return;
    }
    let mut username = field(3);
    if username == "<default>" {
        username.clear();
    } else if username.starts_with('[') && username.ends_with(']') {
        // A credential stored in MobaXterm, which an export does not include.
        parsed.warnings.push(format!(
            "{name}: uses the saved credential {username}; enter the user name after importing"
        ));
        username.clear();
    }
    let port = field(2)
        .parse::<i32>()
        .ok()
        .filter(|p| *p > 0)
        .map_or(default_port, |p| p as u16);
    parsed.hosts.push(ImportedHost {
        name: unescape(name.trim()),
        hostname,
        port,
        username,
        protocol,
        folder: folder.map(String::from),
        key_path: key_field
            .and_then(|i| fields.get(i))
            .and_then(|k| key_path(k)),
        color: parts.get(6).and_then(|c| colour(c)),
        ..ImportedHost::default()
    });
}

pub fn looks_like(text: &str) -> bool {
    text.lines()
        .any(|line| line.trim_start().starts_with("[Bookmarks"))
}

pub fn parse(text: &str) -> Parsed {
    let mut parsed = Parsed::default();
    let mut in_bookmarks = false;
    let mut folder: Option<String> = None;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(section) = line
            .trim()
            .strip_prefix('[')
            .and_then(|l| l.strip_suffix(']'))
        {
            in_bookmarks = section == "Bookmarks" || section.starts_with("Bookmarks_");
            folder = None;
            continue;
        }
        if !in_bookmarks {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "SubRep" => {
                let path = value.trim().replace('\\', "/");
                folder = (!path.is_empty()).then_some(path);
            }
            "ImgNum" => {}
            name => session(name, value, folder.as_deref(), &mut parsed),
        }
    }
    if parsed
        .hosts
        .iter()
        .any(|h| h.key_path.as_deref().is_some_and(|k| k.contains('\\')))
    {
        parsed.warnings.push(
            "Some keys point to Windows folders: copy them to this computer and update the path"
                .into(),
        );
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_folders_types_users_keys_and_colours() {
        let ini = "[Bookmarks]\r\nSubRep=\r\nImgNum=42\r\n\
web= #109#0%web.acme.es%2222%deploy%%-1%-1%%%%%0%0%0%_CurrentDrive_:\\Users\\a\\.ssh\\id_ed25519%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0#0# #255\r\n\
[Bookmarks_1]\r\nSubRep=Clientes\\Acme\r\nImgNum=41\r\n\
win01=#91#4%10.0.0.9%%CORP\\adrien%0%0%0%0%-1%0%0%-1%%%%%0%0#MobaFont%10#0# #-1\r\n\
files=#140#7%sftp.acme.es%-1%[Trabajo]%%%%%%_ProfileDir_\\.ssh\\id_rsa%%#MobaFont#0# #-1\r\n\
router=#98#1%192.168.1.1%23%%#MobaFont#0# #-1\r\n\
[Passwords]\r\nweb=encrypted\r\n";
        let parsed = parse(ini);
        let hosts: Vec<_> = parsed
            .hosts
            .iter()
            .map(|h| {
                (
                    h.name.as_str(),
                    h.protocol,
                    h.hostname.as_str(),
                    h.port,
                    h.username.as_str(),
                    h.folder.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            hosts,
            [
                ("web", Protocol::Ssh, "web.acme.es", 2222, "deploy", None),
                (
                    "win01",
                    Protocol::Rdp,
                    "10.0.0.9",
                    3389,
                    "CORP\\adrien",
                    Some("Clientes/Acme")
                ),
                (
                    "files",
                    Protocol::Ssh,
                    "sftp.acme.es",
                    22,
                    "",
                    Some("Clientes/Acme")
                ),
            ]
        );
        assert_eq!(
            parsed.hosts[0].key_path.as_deref(),
            Some("C:\\Users\\a\\.ssh\\id_ed25519")
        );
        assert_eq!(parsed.hosts[0].color.as_deref(), Some("red"));
        assert_eq!(parsed.hosts[2].key_path.as_deref(), Some("~/.ssh/id_rsa"));
        assert!(parsed.warnings.iter().any(|w| w.contains("Telnet")));
        assert!(parsed.warnings.iter().any(|w| w.contains("[Trabajo]")));
        assert!(looks_like(ini));
    }

    #[test]
    fn escapes_are_undone() {
        assert_eq!(unescape("a__PTVIRG__b__PERCENT__c"), "a;b%c");
    }
}
