//! This computer's files, for the local side of the two-pane file browser (like FileZilla's).
//! Paths are handled here, not in the UI, so Windows drive letters and backslashes just work.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::ssh::sftp::SftpEntry;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalListing {
    /// The folder, absolute.
    pub path: String,
    /// Its parent, or `None` at the root of a drive.
    pub parent: Option<String>,
    pub entries: Vec<SftpEntry>,
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// `~` and `~/...` to the home folder.
fn expand(path: &str) -> PathBuf {
    match path.strip_prefix('~') {
        Some(rest) => home().join(rest.trim_start_matches(['/', '\\'])),
        None => PathBuf::from(path),
    }
}

#[cfg(unix)]
fn permissions(metadata: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(metadata.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn permissions(_metadata: &std::fs::Metadata) -> Option<u32> {
    None
}

fn entry(path: &Path) -> Option<SftpEntry> {
    let link = std::fs::symlink_metadata(path).ok()?;
    // Links show what they point to (a broken one shows as a file).
    let metadata = if link.is_symlink() {
        std::fs::metadata(path).unwrap_or(link.clone())
    } else {
        link.clone()
    };
    Some(SftpEntry {
        name: path.file_name()?.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        is_dir: metadata.is_dir(),
        is_symlink: link.is_symlink(),
        size: if metadata.is_dir() { 0 } else { metadata.len() },
        modified: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_secs() as u32),
        permissions: permissions(&metadata),
        owner: None,
    })
}

pub fn list(path: &str) -> Result<LocalListing, String> {
    let dir = expand(path);
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut entries: Vec<SftpEntry> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .filter_map(|item| entry(&item.path()))
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(LocalListing {
        path: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
    })
}

/// A name for a new item, refused if it would land somewhere else.
fn child(dir: &str, name: &str) -> Result<PathBuf, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(format!("invalid name: {name}"));
    }
    Ok(expand(dir).join(name))
}

#[tauri::command]
pub fn local_home() -> String {
    home().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn local_list(path: String) -> Result<LocalListing, String> {
    list(&path)
}

#[tauri::command]
pub fn local_mkdir(dir: String, name: String) -> Result<(), String> {
    std::fs::create_dir(child(&dir, &name)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_rename(path: String, name: String) -> Result<(), String> {
    let from = expand(&path);
    let parent = from.parent().ok_or("cannot rename a drive")?;
    let to = child(&parent.to_string_lossy(), &name)?;
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Deletes a file, or a folder with everything inside it (links are removed, never followed).
#[tauri::command]
pub fn local_delete(path: String) -> Result<(), String> {
    let path = expand(&path);
    let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(&path)
    } else {
        std::fs::remove_file(&path)
    }
    .map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_creates_renames_and_deletes() {
        let dir = std::env::temp_dir().join(format!("ht-localfs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let base = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("b.txt"), b"hola").unwrap();
        local_mkdir(base.clone(), "Zeta".into()).unwrap();
        local_mkdir(base.clone(), "alfa".into()).unwrap();

        let listing = list(&base).unwrap();
        let names: Vec<_> = listing
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.is_dir))
            .collect();
        assert_eq!(names, [("alfa", true), ("Zeta", true), ("b.txt", false)]);
        assert_eq!(listing.entries[2].size, 4);
        assert!(listing.parent.is_some());

        let file = listing.entries[2].path.clone();
        local_rename(file, "c.txt".into()).unwrap();
        assert!(dir.join("c.txt").exists());
        assert!(local_mkdir(base.clone(), "../escape".into()).is_err());

        std::fs::write(dir.join("Zeta/inside"), b"x").unwrap();
        local_delete(dir.join("Zeta").to_string_lossy().into_owned()).unwrap();
        assert!(!dir.join("Zeta").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
