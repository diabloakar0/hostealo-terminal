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
