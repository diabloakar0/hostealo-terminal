//! Resource monitor shown in the status bar under every session.
//!
//! `ResourceSnapshot` is the shared model: the local monitor (desktop only) fills it from `sysinfo`, and SSH
//! sessions will fill it by reading `/proc` over a side exec channel, so the UI does not care
//! where the numbers came from.

#[cfg(desktop)]
use std::sync::Mutex;
#[cfg(desktop)]
use std::time::Instant;

use serde::Serialize;
#[cfg(desktop)]
use sysinfo::{CpuRefreshKind, Disks, MemoryRefreshKind, Networks, RefreshKind, System};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub mount: String,
    pub used: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub cpu_percent: f32,
    pub cpu_count: usize,
    pub mem_used: u64,
    pub mem_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    /// The system/root disk comes first.
    pub disks: Vec<DiskUsage>,
    pub net_rx_bps: f64,
    pub net_tx_bps: f64,
    /// 1, 5 and 15 minute load averages. `None` where the OS has no such concept (Windows).
    pub load: Option<[f64; 3]>,
    pub uptime_secs: u64,
}

#[cfg(desktop)]
pub struct LocalMonitor {
    system: System,
    disks: Disks,
    networks: Networks,
    last_net_refresh: Instant,
}

#[cfg(desktop)]
impl LocalMonitor {
    pub fn new() -> Self {
        let system = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
                .with_memory(MemoryRefreshKind::everything()),
        );
        Self {
            system,
            disks: Disks::new_with_refreshed_list(),
            networks: Networks::new_with_refreshed_list(),
            last_net_refresh: Instant::now(),
        }
    }

    pub fn snapshot(&mut self) -> ResourceSnapshot {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.disks.refresh(true);

        // `received()`/`transmitted()` are deltas since the previous refresh, so divide by the
        // real elapsed time rather than assuming the poll interval.
        self.networks.refresh(true);
        let elapsed = self.last_net_refresh.elapsed().as_secs_f64().max(0.001);
        self.last_net_refresh = Instant::now();
        let (rx, tx) = self
            .networks
            .iter()
            .filter(|(name, _)| !is_loopback(name))
            .fold((0u64, 0u64), |(rx, tx), (_, data)| {
                (rx + data.received(), tx + data.transmitted())
            });

        let load = if cfg!(windows) {
            None
        } else {
            let l = System::load_average();
            Some([l.one, l.five, l.fifteen])
        };

        ResourceSnapshot {
            hostname: System::host_name(),
            os: System::long_os_version(),
            cpu_percent: self.system.global_cpu_usage(),
            cpu_count: self.system.cpus().len(),
            mem_used: self.system.used_memory(),
            mem_total: self.system.total_memory(),
            swap_used: self.system.used_swap(),
            swap_total: self.system.total_swap(),
            disks: self.disk_usage(),
            net_rx_bps: rx as f64 / elapsed,
            net_tx_bps: tx as f64 / elapsed,
            load,
            uptime_secs: System::uptime(),
        }
    }

    fn disk_usage(&self) -> Vec<DiskUsage> {
        let mut seen = std::collections::HashSet::new();
        let mut disks: Vec<DiskUsage> = self
            .disks
            .iter()
            .filter(|d| d.total_space() > 0 && !d.is_removable())
            .filter(|d| !is_system_internal_mount(&d.mount_point().to_string_lossy()))
            // APFS and btrfs expose one device under several mount points; keep the first.
            .filter(|d| seen.insert(d.name().to_os_string()))
            .map(|d| DiskUsage {
                mount: d.mount_point().to_string_lossy().into_owned(),
                used: d.total_space().saturating_sub(d.available_space()),
                total: d.total_space(),
            })
            .collect();
        disks.sort_by_key(|d| !is_root_mount(&d.mount));
        disks
    }
}

#[cfg(desktop)]
fn is_loopback(interface: &str) -> bool {
    interface == "lo" || interface.starts_with("lo0") || interface.starts_with("Loopback")
}

#[cfg(desktop)]
fn is_root_mount(mount: &str) -> bool {
    mount == "/" || mount.eq_ignore_ascii_case("C:\\")
}

#[cfg(desktop)]
fn is_system_internal_mount(mount: &str) -> bool {
    const HIDDEN: &[&str] = &[
        "/System/Volumes/",
        "/private/var/vm",
        "/boot",
        "/snap/",
        "/run/",
        "/dev",
    ];
    HIDDEN.iter().any(|prefix| mount.starts_with(prefix))
}

#[cfg(desktop)]
#[tauri::command]
pub fn monitor_local(
    monitor: tauri::State<'_, Mutex<LocalMonitor>>,
) -> Result<ResourceSnapshot, String> {
    let mut monitor = monitor.lock().map_err(|e| e.to_string())?;
    Ok(monitor.snapshot())
}

// Phones and tablets have no local terminal, so there is no local machine to monitor.

#[cfg(mobile)]
pub struct LocalMonitor;

#[cfg(mobile)]
impl LocalMonitor {
    pub fn new() -> Self {
        Self
    }
}

#[cfg(mobile)]
#[tauri::command]
pub fn monitor_local() -> Result<ResourceSnapshot, String> {
    Err("this device has no local terminal".into())
}
