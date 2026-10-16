//! The user's SSH keys in `~/.ssh`: list, generate (OpenSSH format) and delete.
//! Keys are generated in-process, so this also works where `ssh-keygen` does not exist (iOS).

use std::path::{Path, PathBuf};

use russh::keys::ssh_key::{LineEnding, PrivateKey, PublicKey};
use russh::keys::{Algorithm, EcdsaCurve, HashAlg};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    pub name: String,
    pub path: String,
    pub key_type: String,
    pub fingerprint: Option<String>,
    pub comment: String,
    pub encrypted: bool,
    /// One line in `authorized_keys` format, ready to copy.
    pub public_key: Option<String>,
    /// Seconds since the Unix epoch.
    pub modified: Option<u64>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyAlgorithm {
    Ed25519,
    Ecdsa,
    Rsa,
}

fn ssh_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or("home directory not found")?;
    Ok(Path::new(&home).join(".ssh"))
}

const NOT_KEYS: &[&str] = &[
    "known_hosts",
    "known_hosts.old",
    "config",
    "authorized_keys",
    "authorized_keys2",
    "environment",
];

fn inspect(path: &Path) -> Option<SshKeyInfo> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    if name.ends_with(".pub") || name.starts_with('.') || NOT_KEYS.contains(&name.as_str()) {
        return None;
    }
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    if !content.contains("PRIVATE KEY-----") && !content.starts_with("PuTTY-User-Key-File") {
        return None;
    }

    // OpenSSH keys keep the public half in clear even when encrypted. For other formats (PEM,
    // PuTTY) fall back to the `.pub` file next to the key.
    let parsed = PrivateKey::from_openssh(&content).ok();
    let public_file = std::fs::read_to_string(path.with_file_name(format!("{name}.pub")))
        .ok()
        .and_then(|line| PublicKey::from_openssh(line.trim()).ok());
    let public = parsed
        .as_ref()
        .map(|k| k.public_key().clone())
        .or_else(|| public_file.clone());

    let comment = public_file
        .as_ref()
        .map(|k| k.comment().to_string())
        .filter(|c| !c.is_empty())
        .or_else(|| parsed.as_ref().map(|k| k.comment().to_string()))
        .unwrap_or_default();
    let encrypted = parsed
        .as_ref()
        .map_or_else(|| content.contains("ENCRYPTED"), PrivateKey::is_encrypted);

    Some(SshKeyInfo {
        name,
        path: path.to_string_lossy().into_owned(),
        key_type: public
            .as_ref()
            .map_or_else(|| "unknown".into(), |k| k.algorithm().to_string()),
        fingerprint: public
            .as_ref()
            .map(|k| k.fingerprint(HashAlg::Sha256).to_string()),
        public_key: public.as_ref().and_then(|k| {
            let mut k = k.clone();
            k.set_comment(comment.as_str());
            k.to_openssh().ok()
        }),
        comment,
        encrypted,
        modified: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
    })
}

fn list_in(dir: &Path) -> Vec<SshKeyInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut keys: Vec<SshKeyInfo> = entries
        .flatten()
        .filter_map(|entry| inspect(&entry.path()))
        .collect();
    keys.sort_by(|a, b| a.name.cmp(&b.name));
    keys
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '@'))
        && !name.ends_with(".pub")
        && !NOT_KEYS.contains(&name)
}

/// Writes a file readable only by the owner, as OpenSSH requires for private keys.
fn write_private(path: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())
}

fn generate_in(
    dir: &Path,
    name: &str,
    algorithm: KeyAlgorithm,
    passphrase: Option<&str>,
    comment: &str,
) -> Result<SshKeyInfo, String> {
    if !valid_name(name) {
        return Err("invalid key name".into());
    }
    let path = dir.join(name);
    let public_path = dir.join(format!("{name}.pub"));
    if path.exists() || public_path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    if !dir.exists() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }

    let algorithm = match algorithm {
        KeyAlgorithm::Ed25519 => Algorithm::Ed25519,
        KeyAlgorithm::Ecdsa => Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP256,
        },
        KeyAlgorithm::Rsa => Algorithm::Rsa { hash: None },
    };
    let mut rng = rand::rng();
    let mut key = PrivateKey::random(&mut rng, algorithm).map_err(|e| e.to_string())?;
    key.set_comment(comment);
    let public_line = key.public_key().to_openssh().map_err(|e| e.to_string())?;
    if let Some(passphrase) = passphrase.filter(|p| !p.is_empty()) {
        key = key
            .encrypt(&mut rng, passphrase)
            .map_err(|e| e.to_string())?;
    }
    let private = key.to_openssh(LineEnding::LF).map_err(|e| e.to_string())?;

    write_private(&path, &private)?;
    if let Err(e) = std::fs::write(&public_path, format!("{public_line}\n")) {
        let _ = std::fs::remove_file(&path);
        return Err(e.to_string());
    }
    inspect(&path).ok_or_else(|| "generated key could not be read back".into())
}

#[tauri::command]
pub fn ssh_keys_list() -> Result<Vec<SshKeyInfo>, String> {
    Ok(list_in(&ssh_dir()?))
}

/// Runs on a worker thread: RSA generation takes a while.
#[tauri::command]
pub async fn ssh_keys_generate(
    name: String,
    algorithm: KeyAlgorithm,
    passphrase: Option<String>,
    comment: String,
) -> Result<SshKeyInfo, String> {
    let dir = ssh_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        generate_in(&dir, &name, algorithm, passphrase.as_deref(), &comment)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes a key and its `.pub`. Only files inside `~/.ssh` that look like keys can be deleted.
#[tauri::command]
pub fn ssh_keys_delete(path: String) -> Result<(), String> {
    let dir = ssh_dir()?;
    let path = PathBuf::from(path);
    if path.parent() != Some(dir.as_path()) || inspect(&path).is_none() {
        return Err("not an SSH key in ~/.ssh".into());
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    let public = path.with_file_name(format!(
        "{}.pub",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    match std::fs::remove_file(public) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// A sensible default comment: `user@hostname`, like ssh-keygen.
#[tauri::command]
pub fn ssh_keys_default_comment() -> String {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    let host = sysinfo::System::host_name().unwrap_or_default();
    match (user.is_empty(), host.is_empty()) {
        (false, false) => format!("{user}@{host}"),
        (false, true) => user,
        _ => host,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_keys_are_listed_and_usable() {
        let dir = std::env::temp_dir().join(format!("ht-keys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let plain =
            generate_in(&dir, "id_ed25519", KeyAlgorithm::Ed25519, None, "me@test").unwrap();
        assert_eq!(plain.key_type, "ssh-ed25519");
        assert!(!plain.encrypted);
        assert_eq!(plain.comment, "me@test");
        assert!(
            plain
                .public_key
                .as_deref()
                .unwrap()
                .starts_with("ssh-ed25519 AAAA")
        );
        assert!(plain.public_key.as_deref().unwrap().ends_with(" me@test"));

        let locked =
            generate_in(&dir, "id_ecdsa", KeyAlgorithm::Ecdsa, Some("pw"), "me@test").unwrap();
        assert!(locked.encrypted);
        assert_eq!(locked.key_type, "ecdsa-sha2-nistp256");
        // The key decrypts with its passphrase, as the SSH client will do.
        let content = std::fs::read_to_string(&locked.path).unwrap();
        assert!(russh::keys::decode_secret_key(&content, Some("pw")).is_ok());
        assert!(matches!(
            russh::keys::decode_secret_key(&content, None),
            Err(russh::keys::Error::KeyIsEncrypted)
        ));

        // OpenSSH itself must read our files: derive the public key with ssh-keygen and compare.
        for (key, passphrase) in [(&plain, ""), (&locked, "pw")] {
            let Ok(out) = std::process::Command::new("ssh-keygen")
                .args(["-y", "-P", passphrase, "-f", &key.path])
                .output()
            else {
                continue; // ssh-keygen not installed
            };
            assert!(
                out.status.success(),
                "ssh-keygen: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            let derived = String::from_utf8_lossy(&out.stdout);
            let ours = key.public_key.as_deref().unwrap();
            assert_eq!(
                derived.split_whitespace().nth(1),
                ours.split_whitespace().nth(1)
            );
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&plain.path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        // Files that are not keys are ignored.
        std::fs::write(dir.join("config"), "Host *\n").unwrap();
        std::fs::write(dir.join("notes.txt"), "hello").unwrap();
        let names: Vec<String> = list_in(&dir).into_iter().map(|k| k.name).collect();
        assert_eq!(names, ["id_ecdsa", "id_ed25519"]);

        assert!(
            generate_in(&dir, "id_ed25519", KeyAlgorithm::Ed25519, None, "").is_err(),
            "must not overwrite"
        );
        assert!(generate_in(&dir, "../evil", KeyAlgorithm::Ed25519, None, "").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
