//! Agentless resource monitor for SSH hosts.
//!
//! A second channel on the same connection runs a tiny POSIX `sh` loop that prints `/proc` and
//! `df` every two seconds. Nothing is installed on the server, and the script is sent on stdin
//! (`sh -s`), so it works whatever the user's login shell is (bash, zsh, fish...).

use std::time::Instant;

use russh::ChannelMsg;
use russh::client::Msg;
use serde::Serialize;
use tauri::ipc::Channel;

use crate::monitor::{DiskUsage, ResourceSnapshot};

const END: &[u8] = b"__HT_END__\n";
const UNSUPPORTED: &str = "__HT_UNSUPPORTED__";

const SCRIPT: &str = r#"LC_ALL=C; export LC_ALL
if [ ! -r /proc/stat ]; then echo __HT_UNSUPPORTED__; echo __HT_END__; exit 0; fi
first=1
while :; do
  echo @host; hostname 2>/dev/null || cat /proc/sys/kernel/hostname
  echo @os; ( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" )
  echo @stat; grep ^cpu /proc/stat
  echo @mem; cat /proc/meminfo
  echo @load; cat /proc/loadavg
  echo @uptime; cat /proc/uptime
  echo @net; cat /proc/net/dev
  echo @df; df -P -k 2>/dev/null
  echo __HT_END__
  if [ $first = 1 ]; then first=0; sleep 1; else sleep 2; fi
done
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MonitorEvent {
    Snapshot {
        snapshot: ResourceSnapshot,
    },
    /// Not a Linux host (no /proc), or the exec channel was refused.
    Unsupported,
}

pub async fn run(mut channel: russh::Channel<Msg>, events: Channel<MonitorEvent>) {
    let started = async {
        channel.exec(true, "sh -s").await?;
        channel.data_bytes(SCRIPT.as_bytes().to_vec()).await?;
        channel.eof().await
    };
    if started.await.is_err() {
        let _ = events.send(MonitorEvent::Unsupported);
        return;
    }

    let mut parser = Parser::default();
    let mut buffer = Vec::new();
    while let Some(msg) = channel.wait().await {
        let ChannelMsg::Data { data } = msg else {
            continue;
        };
        buffer.extend_from_slice(&data);
        while let Some(end) = find(&buffer, END) {
            let block = String::from_utf8_lossy(&buffer[..end]).into_owned();
            buffer.drain(..end + END.len());
            if block.contains(UNSUPPORTED) {
                let _ = events.send(MonitorEvent::Unsupported);
                return;
            }
            if let Some(snapshot) = parser.parse(&block, Instant::now())
                && events.send(MonitorEvent::Snapshot { snapshot }).is_err()
            {
                // The tab is gone.
                let _ = channel.close().await;
                return;
            }
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[derive(Default)]
struct Parser {
    /// (total, idle) jiffies from the previous sample.
    cpu: Option<(u64, u64)>,
    /// (rx bytes, tx bytes, when).
    net: Option<(u64, u64, Instant)>,
}

impl Parser {
    /// Returns `None` for the first sample: CPU usage and network rates need two samples.
    fn parse(&mut self, block: &str, now: Instant) -> Option<ResourceSnapshot> {
        let section = |name: &str| section(block, name);

        let (cpu_total, cpu_idle, cpu_count) = parse_cpu(section("stat"))?;
        let cpu_percent = self
            .cpu
            .replace((cpu_total, cpu_idle))
            .map(|(total, idle)| {
                let total = cpu_total.saturating_sub(total);
                let idle = cpu_idle.saturating_sub(idle);
                if total == 0 {
                    0.0
                } else {
                    (total - idle.min(total)) as f32 / total as f32 * 100.0
                }
            });

        let (rx, tx) = parse_net(section("net"));
        let rates = self
            .net
            .replace((rx, tx, now))
            .map(|(prev_rx, prev_tx, then)| {
                let secs = now.duration_since(then).as_secs_f64().max(0.001);
                (
                    rx.saturating_sub(prev_rx) as f64 / secs,
                    tx.saturating_sub(prev_tx) as f64 / secs,
                )
            });

        let mem = parse_meminfo(section("mem"));
        let kb = |key: &str| {
            mem.iter()
                .find(|(k, _)| *k == key)
                .map_or(0, |(_, v)| *v * 1024)
        };
        let mem_total = kb("MemTotal");
        let mem_available = match kb("MemAvailable") {
            0 => kb("MemFree") + kb("Buffers") + kb("Cached"),
            available => available,
        };

        let load = section("load")
            .split_whitespace()
            .take(3)
            .map(str::parse::<f64>)
            .collect::<Result<Vec<_>, _>>();
        let uptime = section("uptime")
            .split_whitespace()
            .next()
            .and_then(|s| s.parse::<f64>().ok());

        let (cpu_percent, (net_rx_bps, net_tx_bps)) = (cpu_percent?, rates?);
        Some(ResourceSnapshot {
            hostname: non_empty(section("host")),
            os: non_empty(section("os")),
            cpu_percent,
            cpu_count,
            mem_used: mem_total.saturating_sub(mem_available),
            mem_total,
            swap_used: kb("SwapTotal").saturating_sub(kb("SwapFree")),
            swap_total: kb("SwapTotal"),
            disks: parse_df(section("df")),
            net_rx_bps,
            net_tx_bps,
            load: load.ok().and_then(|l| l.try_into().ok()),
            uptime_secs: uptime.unwrap_or(0.0) as u64,
        })
    }
}

/// Text between the `@name` line and the next `@...` line.
fn section<'a>(block: &'a str, name: &str) -> &'a str {
    let header = format!("@{name}\n");
    let Some(start) = block.find(&header).map(|i| i + header.len()) else {
        return "";
    };
    let rest = &block[start..];
    let end = rest.find("\n@").map_or(rest.len(), |i| i + 1);
    &rest[..end]
}

fn non_empty(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// From `/proc/stat`: (total jiffies, idle jiffies, number of CPUs).
fn parse_cpu(stat: &str) -> Option<(u64, u64, usize)> {
    let mut lines = stat.lines();
    let fields: Vec<u64> = lines
        .next()?
        .strip_prefix("cpu ")?
        .split_whitespace()
        .filter_map(|f| f.parse().ok())
        .collect();
    // user nice system idle iowait irq softirq steal; guest time is already counted in user.
    let total: u64 = fields.iter().take(8).sum();
    let idle = fields.get(3).copied().unwrap_or(0) + fields.get(4).copied().unwrap_or(0);
    let count = lines.filter(|l| l.starts_with("cpu")).count();
    Some((total, idle, count.max(1)))
}

fn parse_meminfo(meminfo: &str) -> Vec<(&str, u64)> {
    meminfo
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.trim(), value.split_whitespace().next()?.parse().ok()?))
        })
        .collect()
}

/// Total received/transmitted bytes over all interfaces except loopback.
fn parse_net(dev: &str) -> (u64, u64) {
    dev.lines()
        .filter_map(|line| {
            let (iface, counters) = line.split_once(':')?;
            if iface.trim() == "lo" {
                return None;
            }
            let fields: Vec<u64> = counters
                .split_whitespace()
                .filter_map(|f| f.parse().ok())
                .collect();
            Some((*fields.first()?, *fields.get(8)?))
        })
        .fold((0, 0), |(rx, tx), (r, t)| (rx + r, tx + t))
}

/// Real block devices from `df -P -k`, root filesystem first.
fn parse_df(df: &str) -> Vec<DiskUsage> {
    let mut seen = std::collections::HashSet::new();
    let mut disks: Vec<DiskUsage> = df
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 6 {
                return None;
            }
            let (device, mount) = (fields[0], fields[5..].join(" "));
            let real = device.starts_with("/dev/") && !device.starts_with("/dev/loop");
            if !(real || mount == "/") || mount.starts_with("/boot") || mount.starts_with("/snap") {
                return None;
            }
            if !seen.insert(device.to_string()) {
                return None;
            }
            let used: u64 = fields[2].parse().ok()?;
            let available: u64 = fields[3].parse().ok()?;
            Some(DiskUsage {
                mount,
                used: used * 1024,
                total: (used + available) * 1024,
            })
        })
        .collect();
    disks.sort_by_key(|d| d.mount != "/");
    disks
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn block(cpu: &str, rx: u64, tx: u64) -> String {
        format!(
            "@host\nweb-01\n@os\nUbuntu 24.04.1 LTS\n@stat\n{cpu}\ncpu0 1 1 1 1 1 0 0 0 0 0\ncpu1 1 1 1 1 1 0 0 0 0 0\n\
             @mem\nMemTotal:        8000000 kB\nMemFree:          500000 kB\nMemAvailable:    6000000 kB\n\
             SwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n\
             @load\n0.42 0.30 0.10 1/234 5678\n@uptime\n1036800.55 2000000.00\n\
             @net\nInter-|   Receive\n face |bytes    packets\n    lo: 999999 1 0 0 0 0 0 0 999999 1 0 0 0 0 0 0\n\
               eth0: {rx} 10 0 0 0 0 0 0 {tx} 10 0 0 0 0 0 0\n\
             @df\nFilesystem     1024-blocks    Used Available Capacity Mounted on\n\
             tmpfs              400000     1000    399000       1% /run\n\
             /dev/vda1        40000000 16000000  24000000      40% /\n\
             /dev/loop0          60000    60000         0     100% /snap/core/1\n\
             /dev/vdb1       100000000 10000000 90000000      10% /mnt/my data\n"
        )
    }

    #[test]
    fn first_sample_is_skipped_then_deltas_are_used() {
        let mut parser = Parser::default();
        let t0 = Instant::now();
        assert!(
            parser
                .parse(&block("cpu  100 0 100 700 100 0 0 0 0 0", 1000, 2000), t0)
                .is_none()
        );

        // +200 busy, +200 idle (incl. iowait) => 50 %; +4096 B rx in 2 s => 2048 B/s.
        let s = parser
            .parse(
                &block("cpu  200 0 200 850 150 0 0 0 0 0", 5096, 2000),
                t0 + Duration::from_secs(2),
            )
            .expect("second sample");
        assert!((s.cpu_percent - 50.0).abs() < 0.01, "cpu {}", s.cpu_percent);
        assert_eq!(s.cpu_count, 2);
        assert!((s.net_rx_bps - 2048.0).abs() < 0.01);
        assert_eq!(s.net_tx_bps, 0.0);
        assert_eq!(s.mem_total, 8_000_000 * 1024);
        assert_eq!(s.mem_used, 2_000_000 * 1024);
        assert_eq!(s.swap_used, 500_000 * 1024);
        assert_eq!(s.load, Some([0.42, 0.30, 0.10]));
        assert_eq!(s.uptime_secs, 1_036_800);
        assert_eq!(s.hostname.as_deref(), Some("web-01"));
        assert_eq!(s.os.as_deref(), Some("Ubuntu 24.04.1 LTS"));

        let mounts: Vec<&str> = s.disks.iter().map(|d| d.mount.as_str()).collect();
        assert_eq!(mounts, ["/", "/mnt/my data"]);
        assert_eq!(s.disks[0].used, 16_000_000 * 1024);
        assert_eq!(s.disks[0].total, 40_000_000 * 1024);
    }

    #[test]
    fn script_output_split_across_chunks_is_reassembled() {
        let mut buffer = b"@host\nweb".to_vec();
        assert!(find(&buffer, END).is_none());
        buffer.extend_from_slice(b"-01\n__HT_END__\n@host");
        let end = find(&buffer, END).expect("marker");
        assert_eq!(&buffer[..end], b"@host\nweb-01\n");
    }
}
