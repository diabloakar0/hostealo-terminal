//! Servers passed over in QR codes, for devices that cannot reach each other on a network (one
//! behind a VPN, the other on another Wi-Fi...): the computer shows the codes and the phone reads
//! them with its camera, the way authenticator apps move their accounts.
//!
//! The transfer is a backup (compressed, then encrypted with a random code) cut into parts, one
//! per QR code, each a link: `hostealo-terminal://qr?s=<transfer>&i=<part>&n=<parts>&k=<code>&d=<data>`.
//! Without the passwords the code travels in `k` and nothing has to be typed. With them `k` is
//! empty: the code is only on the computer's screen and is typed on the phone, so a photo of the
//! QR codes alone does not give them away (Argon2id makes the code slow to guess).

use std::io::{Read, Write};

use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
use tauri::AppHandle;

use super::{
    AppStore, Backup, MergeSummary, SyncStore, Unsealed, apply, device_name, read_secrets, seal,
    unseal,
};

pub const QR_PREFIX: &str = "hostealo-terminal://qr?";
/// `HTQR` + format version; also authenticated as associated data.
const QR_MAGIC: &[u8; 8] = b"HTQR\x00\x00\x00\x01";
/// Bytes of the transfer per code: a code of medium density (version ~27), which a phone reads
/// even off a low-resolution screen. Twenty servers take some 450 bytes.
const PART: usize = 900;
/// Most parts a transfer may have (a few thousand servers fit).
const MAX_PARTS: usize = 64;
/// The code's letters: no 0/O, 1/I/L or U, which are easy to misread.
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN: usize = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrExport {
    /// The text of each QR code, in order.
    pub frames: Vec<String>,
    /// The code to type on the other device; only when the passwords travel too.
    pub code: Option<String>,
    pub hosts: usize,
    pub secrets: usize,
}

/// Whether `link` is one of the QR codes of a transfer.
pub fn is_frame(link: &str) -> bool {
    link.trim().starts_with(QR_PREFIX)
}

/// A random code such as `K7QM2XPA` (shown as `K7QM-2XPA`).
fn new_code() -> Result<String, String> {
    let mut bytes = [0u8; CODE_LEN];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "no randomness".to_string())?;
    // 256 is not a multiple of 30: the first letters come up a hair more often, which costs a
    // fraction of a bit out of ~39.
    Ok(bytes
        .iter()
        .map(|b| CODE_ALPHABET[*b as usize % CODE_ALPHABET.len()] as char)
        .collect())
}

/// The code as typed: any case, with or without the dash or spaces.
fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn frames(backup: &Backup, code_inside: bool) -> Result<(Vec<String>, String), String> {
    let json = serde_json::to_vec(backup).map_err(|e| e.to_string())?;
    let mut deflate = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    deflate.write_all(&json).map_err(|e| e.to_string())?;
    let compressed = deflate.finish().map_err(|e| e.to_string())?;
    let code = new_code()?;
    let sealed = seal(QR_MAGIC, compressed, &code)?;
    let parts: Vec<&[u8]> = sealed.chunks(PART).collect();
    if parts.len() > MAX_PARTS {
        return Err("too many servers to pass over in QR codes: use an encrypted backup".into());
    }
    let mut id = [0u8; 4];
    SystemRandom::new()
        .fill(&mut id)
        .map_err(|_| "no randomness".to_string())?;
    let id = data_encoding::HEXLOWER.encode(&id);
    let key = if code_inside { code.as_str() } else { "" };
    let frames = parts
        .iter()
        .enumerate()
        .map(|(i, part)| {
            format!(
                "{QR_PREFIX}s={id}&i={}&n={}&k={key}&d={}",
                i + 1,
                parts.len(),
                data_encoding::BASE64URL_NOPAD.encode(part)
            )
        })
        .collect();
    Ok((frames, code))
}

struct Frame {
    transfer: String,
    index: usize,
    total: usize,
    key: String,
    data: Vec<u8>,
}

fn parse_frame(text: &str) -> Option<Frame> {
    let query = text.trim().strip_prefix(QR_PREFIX)?;
    let (mut transfer, mut index, mut total, mut key, mut data) = (None, None, None, None, None);
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=')?;
        match name {
            "s" => transfer = Some(value.to_string()),
            "i" => index = value.parse().ok(),
            "n" => total = value.parse().ok(),
            "k" => key = Some(value.to_string()),
            "d" => data = data_encoding::BASE64URL_NOPAD.decode(value.as_bytes()).ok(),
            _ => {}
        }
    }
    let (index, total) = (index?, total?);
    (1..=total).contains(&index).then_some(())?;
    (total <= MAX_PARTS).then_some(())?;
    Some(Frame {
        transfer: transfer?,
        index,
        total,
        key: key?,
        data: data?,
    })
}

/// Puts the parts back together (in any order, repeated ones too) and opens the transfer.
fn open(texts: &[String], code: Option<&str>) -> Result<Backup, String> {
    let frames: Vec<Frame> = texts.iter().filter_map(|t| parse_frame(t)).collect();
    let first = frames
        .first()
        .ok_or("these are not Hostealo Terminal QR codes")?;
    let mut parts: Vec<Option<&[u8]>> = vec![None; first.total];
    for frame in &frames {
        if frame.transfer != first.transfer || frame.total != first.total {
            return Err("these QR codes are from two different transfers: start again".into());
        }
        parts[frame.index - 1] = Some(&frame.data);
    }
    let missing = parts.iter().filter(|p| p.is_none()).count();
    if missing > 0 {
        return Err(format!("{missing} of the QR codes are still missing"));
    }
    let sealed: Vec<u8> = parts.into_iter().flatten().flatten().copied().collect();
    let code = match (first.key.as_str(), code) {
        ("", Some(typed)) => normalize_code(typed),
        ("", None) => return Err("type the code shown on the other device".into()),
        (inside, _) => inside.to_string(),
    };
    let compressed = unseal(QR_MAGIC, &sealed, &code).map_err(|e| match e {
        Unsealed::NotOurs => "these QR codes are from a newer version: update the app".to_string(),
        Unsealed::Damaged => "the QR codes could not be read: start again".into(),
        Unsealed::WrongKey => "that is not the code shown on the other device".into(),
    })?;
    let mut json = Vec::new();
    flate2::read::DeflateDecoder::new(compressed.as_slice())
        // Generous for any list of servers, and no further: the data is not trusted yet.
        .take(64 * 1024 * 1024)
        .read_to_end(&mut json)
        .map_err(|_| "the QR codes could not be read: start again".to_string())?;
    serde_json::from_slice(&json).map_err(|e| format!("unexpected data: {e}"))
}

/// The QR codes that pass this device's servers (and, if asked, its saved passwords) over.
#[tauri::command]
pub async fn sync_qr_export(app: AppHandle, include_secrets: bool) -> Result<QrExport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = AppStore(app);
        let hosts = store.load()?;
        let secrets = if include_secrets {
            read_secrets(&store, &hosts.hosts)
        } else {
            Vec::new()
        };
        let (host_count, secret_count) = (hosts.hosts.len(), secrets.len());
        let backup = Backup {
            device: device_name(),
            created_at: crate::hosts::now_ms(),
            hosts,
            secrets,
        };
        let (frames, code) = frames(&backup, secret_count == 0)?;
        Ok(QrExport {
            frames,
            code: (secret_count > 0).then_some(code),
            hosts: host_count,
            secrets: secret_count,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Merges the servers read from another device's QR codes, the same way as a sync.
#[tauri::command]
pub async fn sync_qr_import(
    app: AppHandle,
    frames: Vec<String>,
    code: Option<String>,
) -> Result<MergeSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backup = open(&frames, code.as_deref())?;
        let store = AppStore(app);
        let local = store.load()?;
        apply(&store, &local, &backup.hosts, backup.secrets)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::super::tests::host;
    use super::super::{HostsData, SharedSecret};
    use super::*;

    fn backup(hosts: usize, secrets: bool) -> Backup {
        let mut data = HostsData::default();
        for i in 0..hosts {
            data.hosts
                .push(host(&format!("h{i}"), &format!("web-{i:02}"), 100));
        }
        Backup {
            device: "MacBook Pro".into(),
            created_at: 1,
            hosts: data,
            secrets: if secrets {
                vec![SharedSecret {
                    host_id: "h0".into(),
                    passphrase: false,
                    value: "s3cr3t".into(),
                }]
            } else {
                Vec::new()
            },
        }
    }

    #[test]
    fn without_passwords_the_codes_open_on_their_own() {
        let (frames, _) = frames(&backup(20, false), true).unwrap();
        // Twenty servers fit in one code.
        assert_eq!(frames.len(), 1);
        assert!(is_frame(&frames[0]));
        let opened = open(&frames, None).unwrap();
        assert_eq!(opened.hosts.hosts.len(), 20);
        assert_eq!(opened.device, "MacBook Pro");
    }

    #[test]
    fn with_passwords_the_code_is_typed() {
        let (frames, code) = frames(&backup(3, true), false).unwrap();
        assert!(frames.iter().all(|f| f.contains("&k=&")));
        assert!(!frames.iter().any(|f| f.contains(&code)));
        assert_eq!(
            open(&frames, None).unwrap_err(),
            "type the code shown on the other device"
        );
        assert_eq!(
            open(&frames, Some("2222-2222")).unwrap_err(),
            "that is not the code shown on the other device"
        );
        let typed = format!("{}-{}", &code[..4], &code[4..]).to_lowercase();
        let opened = open(&frames, Some(&typed)).unwrap();
        assert_eq!(opened.secrets[0].value, "s3cr3t");
    }

    #[test]
    fn many_servers_take_several_codes_read_in_any_order() {
        let (mut frames, _) = frames(&backup(400, false), true).unwrap();
        assert!(frames.len() > 1, "{} parts", frames.len());
        frames.reverse();
        let repeated = frames[0].clone();
        frames.push(repeated);
        assert_eq!(open(&frames, None).unwrap().hosts.hosts.len(), 400);
        frames.remove(1);
        frames.pop();
        assert!(open(&frames, None).unwrap_err().contains("still missing"));
    }

    #[test]
    fn codes_from_two_transfers_do_not_mix() {
        let (a, _) = frames(&backup(400, false), true).unwrap();
        let (b, _) = frames(&backup(400, false), true).unwrap();
        let mixed = vec![a[0].clone(), b[1].clone()];
        assert!(
            open(&mixed, None)
                .unwrap_err()
                .contains("two different transfers")
        );
    }

    #[test]
    fn codes_are_easy_to_read() {
        let code = new_code().unwrap();
        assert_eq!(code.len(), CODE_LEN);
        assert!(code.bytes().all(|c| CODE_ALPHABET.contains(&c)));
        assert_eq!(normalize_code(" k7qm-2xpa "), "K7QM2XPA");
    }
}
