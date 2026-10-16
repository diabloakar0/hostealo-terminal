//! Which operating system an SSH server runs, to show its logo next to the host.
//!
//! Right after connecting, one extra exec channel runs a short POSIX script (`/etc/os-release`,
//! `uname`...). Servers without `sh` (Windows OpenSSH) get `cmd /c ver` instead. Nothing is
//! installed and nothing is left running.

use std::time::Duration;

use russh::ChannelMsg;
use russh::client::Handle;

use super::ClientHandler;
use crate::hosts::HostOs;

const SCRIPT: &str = r#"LC_ALL=C; export LC_ALL
echo @uname; uname -s 2>/dev/null
echo @release; cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null
echo @macos; sw_vers -productVersion 2>/dev/null
echo @proxmox; pveversion 2>/dev/null | head -1
echo @bsd; freebsd-version 2>/dev/null || uname -r 2>/dev/null
echo @end
"#;

const TIMEOUT: Duration = Duration::from_secs(10);

/// Runs `command` (with `stdin`) on its own channel and returns what it printed.
async fn run(handle: &Handle<ClientHandler>, command: &str, stdin: Option<&str>) -> Option<String> {
    let mut channel = handle.channel_open_session().await.ok()?;
    channel.exec(true, command).await.ok()?;
    if let Some(stdin) = stdin {
        channel.data_bytes(stdin.as_bytes().to_vec()).await.ok()?;
    }
    channel.eof().await.ok()?;
    let mut output = Vec::new();
    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => output.extend_from_slice(&data),
                ChannelMsg::ExitStatus { .. } | ChannelMsg::Eof | ChannelMsg::Close => {}
                _ => {}
            }
        }
    };
    let _ = tokio::time::timeout(TIMEOUT, read).await;
    Some(String::from_utf8_lossy(&output).into_owned())
}

pub async fn detect(handle: &Handle<ClientHandler>) -> Option<HostOs> {
    if let Some(output) = run(handle, "sh -s", Some(SCRIPT)).await
        && let Some(os) = parse_posix(&output)
    {
        return Some(os);
    }
    run(handle, "cmd /c ver", None)
        .await
        .as_deref()
        .and_then(parse_windows)
}

/// `KEY=value` / `KEY="value"` from os-release.
fn os_release_value<'a>(release: &'a str, key: &str) -> Option<&'a str> {
    release.lines().find_map(|line| {
        let value = line.strip_prefix(key)?.strip_prefix('=')?;
        let value = value.trim().trim_matches(['"', '\'']);
        (!value.is_empty()).then_some(value)
    })
}

/// os-release IDs with a logo of their own (see packages/ui/src/os-icons.ts).
fn known_id(id: &str) -> Option<&'static str> {
    Some(match id {
        "ubuntu" => "ubuntu",
        "debian" => "debian",
        "raspbian" => "raspberrypi",
        "linuxmint" => "linuxmint",
        "pop" => "popos",
        "kali" => "kali",
        "centos" => "centos",
        "rocky" => "rocky",
        "almalinux" => "almalinux",
        "rhel" => "rhel",
        "fedora" => "fedora",
        "arch" | "archarm" => "arch",
        "manjaro" | "manjaro-arm" => "manjaro",
        "alpine" => "alpine",
        "opensuse" | "opensuse-leap" | "opensuse-tumbleweed" | "opensuse-microos" => "opensuse",
        "sles" | "sled" => "suse",
        "gentoo" => "gentoo",
        "nixos" => "nixos",
        _ => return None,
    })
}

fn parse_posix(output: &str) -> Option<HostOs> {
    // The script's sections, by marker line.
    let mut sections: Vec<(&str, Vec<&str>)> = Vec::new();
    for line in output.lines() {
        let line = line.trim_end_matches('\r');
        match line.strip_prefix('@') {
            Some(name @ ("uname" | "release" | "macos" | "proxmox" | "bsd" | "end")) => {
                sections.push((name, Vec::new()))
            }
            _ => {
                if let Some((_, lines)) = sections.last_mut() {
                    lines.push(line);
                }
            }
        }
    }
    if !sections.iter().any(|(name, _)| *name == "end") {
        return None;
    }
    let section = |name: &str| -> String {
        sections
            .iter()
            .find(|(section, _)| *section == name)
            .map(|(_, lines)| lines.join("\n").trim().to_string())
            .unwrap_or_default()
    };
    let uname = section("uname");
    let release = section("release");
    let os = |id: &str, name: String| {
        Some(HostOs {
            id: id.into(),
            name,
        })
    };

    match uname.as_str() {
        "Darwin" => {
            let version = section("macos");
            return os("macos", format!("macOS {version}").trim().to_string());
        }
        "FreeBSD" => {
            return os(
                "freebsd",
                format!("FreeBSD {}", section("bsd")).trim().to_string(),
            );
        }
        "OpenBSD" => {
            return os(
                "openbsd",
                format!("OpenBSD {}", section("bsd")).trim().to_string(),
            );
        }
        _ => {}
    }

    let name = os_release_value(&release, "PRETTY_NAME")
        .or_else(|| os_release_value(&release, "NAME"))
        .map(String::from);
    // Proxmox VE reports itself as Debian.
    let proxmox = section("proxmox");
    if proxmox.starts_with("pve-manager") {
        let version = proxmox.split('/').nth(1).unwrap_or_default();
        return os(
            "proxmox",
            format!("Proxmox VE {version}").trim().to_string(),
        );
    }
    match (os_release_value(&release, "ID"), name) {
        (Some(id), Some(name)) => os(known_id(id).unwrap_or("linux"), name),
        _ if uname == "Linux" => os("linux", "Linux".into()),
        _ if !uname.is_empty() => os("unix", uname),
        _ => None,
    }
}

/// `Microsoft Windows [Version 10.0.20348.2700]`.
fn parse_windows(output: &str) -> Option<HostOs> {
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("Microsoft Windows"))?;
    let build: Option<u32> = line
        .split("Version ")
        .nth(1)
        .and_then(|version| version.split('.').nth(2))
        .and_then(|build| build.trim_end_matches(']').parse().ok());
    // `ver` gives the build; servers and desktops share builds, so only the family is named.
    let name = match build {
        Some(build) if build >= 22000 => "Windows 11 / Server 2025",
        Some(build) if build >= 20348 => "Windows Server 2022",
        Some(build) if build >= 17763 => "Windows 10 / Server 2019",
        Some(build) if build >= 10240 => "Windows 10 / Server 2016",
        _ => "Windows",
    };
    Some(HostOs {
        id: "windows".into(),
        name: name.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn posix(uname: &str, release: &str, extra: &str) -> Option<HostOs> {
        parse_posix(&format!(
            "@uname\n{uname}\n@release\n{release}\n@macos\n@proxmox\n{extra}\n@bsd\n@end\n"
        ))
    }

    fn id_name(os: Option<HostOs>) -> Option<(String, String)> {
        os.map(|os| (os.id, os.name))
    }

    #[test]
    fn linux_distributions_are_recognised() {
        let ubuntu =
            "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"";
        assert_eq!(
            id_name(posix("Linux", ubuntu, "")),
            Some(("ubuntu".into(), "Ubuntu 24.04.1 LTS".into()))
        );
        let alma =
            "NAME=\"AlmaLinux\"\nID=\"almalinux\"\nPRETTY_NAME=\"AlmaLinux 9.4 (Seafoam Ocelot)\"";
        assert_eq!(id_name(posix("Linux", alma, "")).unwrap().0, "almalinux");
        // Unknown distributions get the generic Linux logo but keep their name.
        let cloud = "NAME=\"CloudLinux\"\nID=\"cloudlinux\"\nPRETTY_NAME=\"CloudLinux 8.10\"";
        assert_eq!(
            id_name(posix("Linux", cloud, "")),
            Some(("linux".into(), "CloudLinux 8.10".into()))
        );
        assert_eq!(
            id_name(posix("Linux", "", "")),
            Some(("linux".into(), "Linux".into()))
        );
    }

    #[test]
    fn proxmox_is_told_apart_from_debian() {
        let debian = "PRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\nID=debian";
        assert_eq!(
            id_name(posix(
                "Linux",
                debian,
                "pve-manager/8.2.4/faa83925c9641325 (running kernel: 6.8.12-1-pve)"
            )),
            Some(("proxmox".into(), "Proxmox VE 8.2.4".into()))
        );
        assert_eq!(id_name(posix("Linux", debian, "")).unwrap().0, "debian");
    }

    #[test]
    fn bsd_and_macos_are_recognised() {
        let freebsd =
            parse_posix("@uname\nFreeBSD\n@release\n@macos\n@proxmox\n@bsd\n14.1-RELEASE\n@end\n");
        assert_eq!(
            id_name(freebsd),
            Some(("freebsd".into(), "FreeBSD 14.1-RELEASE".into()))
        );
        let mac =
            parse_posix("@uname\nDarwin\n@release\n@macos\n15.1\n@proxmox\n@bsd\n24.1.0\n@end\n");
        assert_eq!(id_name(mac), Some(("macos".into(), "macOS 15.1".into())));
        // Output that is not the script's (a shell that ignored it) is not guessed at.
        assert_eq!(
            parse_posix("'sh' is not recognized as an internal or external command"),
            None
        );
    }

    #[test]
    fn windows_is_recognised_from_ver() {
        let os = parse_windows("\r\nMicrosoft Windows [Version 10.0.20348.2700]\r\n").unwrap();
        assert_eq!(
            (os.id.as_str(), os.name.as_str()),
            ("windows", "Windows Server 2022")
        );
        assert_eq!(parse_windows("bash: cmd: command not found"), None);
    }
}
