//! Microsoft `.rdp` files (Remote Desktop Connection, Windows App, Royal and others export them).

use super::{ImportedHost, Parsed};
use crate::hosts::Protocol;

/// `full address:s:host:port`, IPv6 in brackets.
fn split_address(address: &str) -> (String, Option<u16>) {
    if let Some(rest) = address.strip_prefix('[')
        && let Some((host, port)) = rest.split_once(']')
    {
        return (
            host.to_string(),
            port.strip_prefix(':').and_then(|p| p.parse().ok()),
        );
    }
    match address.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => (host.to_string(), port.parse().ok()),
        _ => (address.to_string(), None),
    }
}

pub fn parse(name: &str, text: &str) -> Parsed {
    let value = |key: &str| {
        text.lines().find_map(|line| {
            let (k, rest) = line.trim().split_once(':')?;
            let (_, value) = rest.split_once(':')?;
            k.eq_ignore_ascii_case(key)
                .then(|| value.trim().to_string())
        })
    };
    let Some((hostname, port)) = value("full address").map(|a| split_address(&a)) else {
        return Parsed {
            warnings: vec![format!("{name}: no address in the file")],
            ..Parsed::default()
        };
    };
    let port = port
        .or_else(|| value("server port").and_then(|p| p.parse().ok()))
        .unwrap_or(3389);
    let mut username = value("username").unwrap_or_default();
    if let Some(domain) = value("domain").filter(|d| !d.is_empty())
        && !username.is_empty()
        && !username.contains(['\\', '@'])
    {
        username = format!("{domain}\\{username}");
    }
    Parsed {
        hosts: vec![ImportedHost {
            name: name.to_string(),
            hostname,
            port,
            username,
            protocol: Protocol::Rdp,
            ..ImportedHost::default()
        }],
        warnings: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_address_port_and_user() {
        let file = "screen mode id:i:2\r\nfull address:s:win.example.com:3390\r\nusername:s:admin\r\ndomain:s:ACME\r\n";
        let host = &parse("Servidor Windows", file).hosts[0];
        assert_eq!(
            (
                host.name.as_str(),
                host.hostname.as_str(),
                host.port,
                host.username.as_str()
            ),
            ("Servidor Windows", "win.example.com", 3390, "ACME\\admin")
        );
        let ipv6 = &parse("v6", "full address:s:[2001:db8::5]\nserver port:i:3391\n").hosts[0];
        assert_eq!((ipv6.hostname.as_str(), ipv6.port), ("2001:db8::5", 3391));
        assert!(parse("vacío", "audiomode:i:0\n").hosts.is_empty());
    }
}
