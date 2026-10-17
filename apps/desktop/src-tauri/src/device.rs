//! Facts about this device that the sessions need: its name (RDP, sync, key comments), its
//! addresses on the local network (sync) and the free space of a disk (the RDP shared drive).
//!
//! `sysinfo` answers on desktop; it does not build for iOS, where the same answers come from
//! the C library and from `if-addrs`.

/// This device's network name, when it has one.
pub fn host_name() -> Option<String> {
    #[cfg(desktop)]
    {
        sysinfo::System::host_name()
    }
    #[cfg(mobile)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is valid for its length and gethostname NUL-terminates within it.
        let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        let name = String::from_utf8_lossy(&buf[..end]);
        let name = name.trim_end_matches(".local").trim();
        (ok && !name.is_empty() && name != "localhost").then(|| name.to_string())
    }
}

/// The name to show for this device on others: the computer's name on a Mac ("MacBook Pro"),
/// the kind of device on an iPhone or iPad (iOS keeps the name the user gave it private, and
/// its host name is "localhost"), the host name elsewhere.
pub fn display_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let computer = std::process::Command::new("/usr/sbin/scutil")
            .args(["--get", "ComputerName"])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|name| !name.is_empty());
        if computer.is_some() {
            return computer;
        }
    }
    #[cfg(target_os = "ios")]
    {
        // "iPhone15,2" on a device; the simulator reports the Mac's machine and names the
        // simulated one in its environment.
        let machine = std::env::var("SIMULATOR_MODEL_IDENTIFIER").unwrap_or_else(|_| {
            let mut info = std::mem::MaybeUninit::<libc::utsname>::uninit();
            // SAFETY: uname fills the struct before it is read, and its fields are NUL-terminated.
            if unsafe { libc::uname(info.as_mut_ptr()) } != 0 {
                return String::new();
            }
            let info = unsafe { info.assume_init() };
            unsafe { std::ffi::CStr::from_ptr(info.machine.as_ptr()) }
                .to_string_lossy()
                .into_owned()
        });
        return Some(if machine.starts_with("iPad") { "iPad" } else { "iPhone" }.to_string());
    }
    #[allow(unreachable_code)]
    host_name()
}

/// The IPv4 addresses of this device on its networks, without the loopback ones.
pub fn local_ipv4() -> Vec<std::net::IpAddr> {
    #[cfg(desktop)]
    {
        sysinfo::Networks::new_with_refreshed_list()
            .values()
            .flat_map(|network| network.ip_networks().iter().map(|ip| ip.addr))
            .filter(|ip| ip.is_ipv4() && !ip.is_loopback())
            .collect()
    }
    #[cfg(mobile)]
    {
        if_addrs::get_if_addrs()
            .unwrap_or_default()
            .into_iter()
            .map(|interface| interface.ip())
            .filter(|ip| ip.is_ipv4() && !ip.is_loopback())
            .collect()
    }
}

/// A path chosen in the file dialog. On iOS it comes as a `file://` URL (to a copy in the app's
/// temporary folder); elsewhere it is already a path.
pub fn picked_path(picked: &str) -> std::path::PathBuf {
    tauri::Url::parse(picked)
        .ok()
        .filter(|url| url.scheme() == "file")
        .and_then(|url| url.to_file_path().ok())
        .unwrap_or_else(|| picked.into())
}

/// Total and available bytes of the disk holding `path`, when they can be read.
pub fn disk_space(path: &std::path::Path) -> Option<(u64, u64)> {
    #[cfg(desktop)]
    {
        let disks = sysinfo::Disks::new_with_refreshed_list();
        disks
            .iter()
            .filter(|d| path.starts_with(d.mount_point()))
            .max_by_key(|d| d.mount_point().as_os_str().len())
            .map(|d| (d.total_space(), d.available_space()))
    }
    #[cfg(mobile)]
    {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: `path` is NUL-terminated and `stat` is written by statvfs before it is read.
        if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
            return None;
        }
        let stat = unsafe { stat.assume_init() };
        let block = u64::from(stat.f_frsize as u32).max(1);
        Some((
            u64::from(stat.f_blocks) * block,
            u64::from(stat.f_bavail) * block,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picked_paths_accept_file_urls() {
        assert_eq!(
            picked_path("file:///private/var/tmp/es.hostealo.terminal-Inbox/copia%20Mac.hostealo"),
            std::path::Path::new("/private/var/tmp/es.hostealo.terminal-Inbox/copia Mac.hostealo")
        );
        assert_eq!(picked_path("/Users/ana/copia.hostealo"), std::path::Path::new("/Users/ana/copia.hostealo"));
    }
}
