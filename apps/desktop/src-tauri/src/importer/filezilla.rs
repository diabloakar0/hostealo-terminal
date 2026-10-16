//! FileZilla's Site Manager (`sitemanager.xml`, or a sites export). SFTP sites become SSH hosts
//! (whose files open over SFTP). Passwords FileZilla keeps without a master password are imported
//! into the keychain.

use super::{ImportedHost, Parsed};
use crate::hosts::Protocol;

/// FileZilla's site colours (1 red ... 7 orange) as tags of packages/ui/src/host-colors.ts.
const COLOURS: [&str; 7] = ["red", "green", "blue", "amber", "cyan", "pink", "orange"];

fn text(node: roxmltree::Node, tag: &str) -> Option<String> {
    node.children()
        .find(|child| child.has_tag_name(tag))
        .and_then(|child| child.text())
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn server(node: roxmltree::Node, folder: Option<&str>, parsed: &mut Parsed) {
    let name = text(node, "Name")
        .or_else(|| text(node, "Host"))
        .unwrap_or_default();
    let Some(hostname) = text(node, "Host") else {
        return;
    };
    let protocol = match text(node, "Protocol").as_deref().unwrap_or("0") {
        // 0: FTP with TLS when the server offers it; 4: explicit TLS required.
        "0" | "4" => Protocol::Ftps,
        "1" => Protocol::Ssh,
        "3" => {
            parsed.warnings.push(format!(
                "{name}: implicit FTPS (port 990) is not supported; imported as explicit FTPS"
            ));
            Protocol::Ftps
        }
        "6" => Protocol::Ftp,
        other => {
            parsed
                .warnings
                .push(format!("{name}: protocol {other} is not supported"));
            return;
        }
    };
    let default_port = if protocol == Protocol::Ssh { 22 } else { 21 };
    let logon = text(node, "Logontype").unwrap_or_default();
    let password = node
        .children()
        .find(|child| child.has_tag_name("Pass"))
        .filter(|pass| pass.attribute("encoding") != Some("crypt"))
        .and_then(|pass| {
            let value = pass.text()?.trim();
            match pass.attribute("encoding") {
                Some("base64") => data_encoding::BASE64
                    .decode(value.as_bytes())
                    .ok()
                    .and_then(|b| String::from_utf8(b).ok()),
                _ => Some(value.to_string()),
            }
        })
        .filter(|p| !p.is_empty());
    let colour = text(node, "Colour")
        .and_then(|c| c.parse::<usize>().ok())
        .and_then(|c| c.checked_sub(1))
        .and_then(|i| COLOURS.get(i))
        .map(|c| c.to_string());
    parsed.hosts.push(ImportedHost {
        name,
        hostname,
        port: text(node, "Port")
            .and_then(|p| p.parse().ok())
            .unwrap_or(default_port),
        username: if logon == "0" {
            "anonymous".into()
        } else {
            text(node, "User").unwrap_or_default()
        },
        protocol,
        folder: folder.map(String::from),
        key_path: text(node, "Keyfile"),
        color: colour,
        password,
        ..ImportedHost::default()
    });
}

fn walk(node: roxmltree::Node, folder: Option<&str>, parsed: &mut Parsed) {
    for child in node.children().filter(|c| c.is_element()) {
        if child.has_tag_name("Server") {
            server(child, folder, parsed);
        } else if child.has_tag_name("Folder") {
            // The folder's name is its own text, before its sites.
            let name = child
                .children()
                .filter(|c| c.is_text())
                .filter_map(|c| c.text())
                .map(str::trim)
                .find(|t| !t.is_empty())
                .unwrap_or("FileZilla")
                .replace('/', "-");
            let path = match folder {
                Some(parent) => format!("{parent}/{name}"),
                None => name,
            };
            walk(child, Some(&path), parsed);
        }
    }
}

pub fn parse(xml: &str) -> Result<Parsed, String> {
    let document = roxmltree::Document::parse(xml).map_err(|e| format!("FileZilla file: {e}"))?;
    let mut parsed = Parsed::default();
    if let Some(servers) = document.descendants().find(|n| n.has_tag_name("Servers")) {
        walk(servers, None, &mut parsed);
    }
    if xml.contains("encoding=\"crypt\"") {
        parsed.warnings.push(
            "FileZilla protects its passwords with a master password: they were not imported"
                .into(),
        );
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sites_folders_passwords_and_colours() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<FileZilla3 version="3.67.0" platform="mac">
  <Servers>
    <Server>
      <Host>ftp.acme.example</Host><Port>21</Port><Protocol>0</Protocol><Type>0</Type>
      <User>acme</User><Pass encoding="base64">czNjcjN0</Pass><Logontype>1</Logontype>
      <Colour>2</Colour><Name>Acme hosting</Name>
    </Server>
    <Folder expanded="1">Clientes
      <Folder>Beta
        <Server>
          <Host>198.51.100.40</Host><Port>2222</Port><Protocol>1</Protocol>
          <User>deploy</User><Logontype>5</Logontype><Keyfile>/Users/ana/.ssh/beta</Keyfile>
          <Name>beta-shop</Name>
        </Server>
      </Folder>
    </Folder>
    <Server><Host>s3.example</Host><Protocol>5</Protocol><Name>S3</Name></Server>
  </Servers>
</FileZilla3>"#;
        let parsed = parse(xml).unwrap();
        assert_eq!(parsed.hosts.len(), 2);
        let ftp = &parsed.hosts[0];
        assert_eq!(
            (ftp.protocol, ftp.password.as_deref(), ftp.color.as_deref()),
            (Protocol::Ftps, Some("s3cr3t"), Some("green"))
        );
        let sftp = &parsed.hosts[1];
        assert_eq!(
            (
                sftp.protocol,
                sftp.port,
                sftp.folder.as_deref(),
                sftp.key_path.as_deref()
            ),
            (
                Protocol::Ssh,
                2222,
                Some("Clientes/Beta"),
                Some("/Users/ana/.ssh/beta")
            )
        );
        assert!(parsed.warnings.iter().any(|w| w.contains("S3")));
    }
}
