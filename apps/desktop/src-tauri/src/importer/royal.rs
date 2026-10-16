//! Royal TS / Royal TSX documents (`.rtsz`): plain XML, a flat list of objects under
//! `<RTSZDocument>`, each element named after its type with its properties as child elements.
//! Folders come from the `ParentID` chain. Credentials are resolved for the user name only:
//! passwords are always encrypted and are not read.
//!
//! Element names from Royal's own RoyalDocument.PowerShell module and the scripting docs:
//! https://docs.royalapps.com/r2023/scripting/objects/

use std::collections::HashMap;

use super::{ImportedHost, Parsed, nearest_color};
use crate::hosts::Protocol;

const EMPTY_GUID: &str = "00000000-0000-0000-0000-000000000000";

struct Object<'a> {
    kind: &'a str,
    fields: HashMap<&'a str, &'a str>,
}

impl Object<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.fields
            .get(key)
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
    }

    fn id_ref(&self, key: &str) -> Option<&str> {
        self.get(key)
            .map(|v| v.trim_matches(['{', '}']))
            .filter(|v| *v != EMPTY_GUID)
    }
}

pub fn looks_like(text: &str) -> bool {
    text.contains("<RTSZDocument") || text.contains("<NewDataSet")
}

pub fn parse(xml: &str) -> Result<Parsed, String> {
    if xml.contains("<NewDataSet") && !xml.contains("<RTSZDocument") {
        return Err(
            "this Royal TS document uses an old format: open it in Royal TS and save it again"
                .into(),
        );
    }
    let document =
        roxmltree::Document::parse(xml).map_err(|e| format!("Royal TS document: {e}"))?;
    let root = document.root_element();
    let mut objects: HashMap<&str, Object> = HashMap::new();
    let mut order = Vec::new();
    for node in root.children().filter(|n| n.is_element()) {
        let fields: HashMap<&str, &str> = node
            .children()
            .filter(|c| c.is_element())
            .map(|c| (c.tag_name().name(), c.text().unwrap_or_default()))
            .collect();
        let Some(id) = fields
            .get("ID")
            .map(|id| id.trim().trim_matches(['{', '}']))
        else {
            continue;
        };
        order.push(id);
        objects.insert(
            id,
            Object {
                kind: node.tag_name().name(),
                fields,
            },
        );
    }

    let parent = |object: &Object| object.id_ref("ParentID").and_then(|id| objects.get(id));
    // Folder names from the top down; `None` when the object is in the trash.
    let folder_of = |object: &Object| -> Option<Option<String>> {
        let mut names = Vec::new();
        let mut current = parent(object);
        let mut guard = 0;
        while let Some(folder) = current {
            match folder.kind {
                "RoyalTrash" => return None,
                "RoyalFolder" | "RoyalDynamicFolder" => {
                    names.push(folder.get("Name").unwrap_or("Royal").replace('/', "-"))
                }
                _ => {}
            }
            current = parent(folder);
            guard += 1;
            if guard > 64 {
                break;
            }
        }
        names.reverse();
        Some((!names.is_empty()).then(|| names.join("/")))
    };
    let credential_by_name = |name: &str| {
        objects
            .values()
            .find(|o| o.kind == "RoyalCredential" && o.get("Name") == Some(name))
    };
    // The user name and key of an object, following "use the parent's credentials".
    let key_file = |object: &Object| {
        object
            .get("CredentialKeyFile")
            .filter(|_| object.get("CredentialKeyMode").is_none_or(|m| m == "0"))
            .map(String::from)
    };
    let credentials = |object: &Object| -> (Option<String>, Option<String>) {
        // A key set on the connection itself wins over its credential's.
        let own_key = key_file(object);
        let mut current = Some(object);
        let mut guard = 0;
        while let Some(object) = current {
            let key = own_key.clone().or_else(|| key_file(object));
            let credential = match object.get("CredentialMode") {
                Some("1") => {
                    current = parent(object);
                    guard += 1;
                    if guard > 64 {
                        break;
                    }
                    continue;
                }
                Some("2") => return (object.get("CredentialUsername").map(String::from), key),
                Some("3") => object.id_ref("CredentialId").and_then(|id| objects.get(id)),
                Some("4") => object.get("CredentialName").and_then(credential_by_name),
                _ => return (None, key),
            };
            return match credential {
                Some(credential) => (
                    credential.get("UserName").map(String::from),
                    key.or_else(|| credential.get("PrivateKeyPath").map(String::from)),
                ),
                None => (None, key),
            };
        }
        (None, None)
    };
    // The object's colour, or the nearest folder's.
    let colour_of = |object: &Object| -> Option<String> {
        let mut current = Some(object);
        let mut guard = 0;
        while let Some(object) = current {
            if let Some(hex) = object
                .get("Color")
                .and_then(|c| c.strip_prefix('#'))
                .filter(|c| c.len() >= 6)
            {
                let hex = &hex[hex.len() - 6..];
                let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
                return nearest_color(byte(0)?, byte(2)?, byte(4)?);
            }
            current = parent(object);
            guard += 1;
            if guard > 64 {
                break;
            }
        }
        None
    };

    let mut parsed = Parsed::default();
    for id in order {
        let object = &objects[id];
        let name = object.get("Name").unwrap_or_default().to_string();
        let (protocol, default_port, port_field) = match object.kind {
            "RoyalSSHConnection" => {
                let kind = object
                    .get("ConnectionType")
                    .unwrap_or("ssh")
                    .split(';')
                    .next()
                    .unwrap_or_default();
                if !kind.eq_ignore_ascii_case("ssh") {
                    parsed
                        .warnings
                        .push(format!("{name}: {kind} connections are not supported"));
                    continue;
                }
                (Protocol::Ssh, 22, "Port")
            }
            "RoyalRDSConnection" => (Protocol::Rdp, 3389, "RDPPort"),
            "RoyalFileTransferConnection" => match object.get("Protocol").unwrap_or("0") {
                "0" => (Protocol::Ftp, 21, "Port"),
                "1" => {
                    parsed.warnings.push(format!(
                        "{name}: implicit FTPS is not supported; imported as explicit FTPS"
                    ));
                    (Protocol::Ftps, 21, "Port")
                }
                "2" => (Protocol::Ftps, 21, "Port"),
                _ => (Protocol::Ssh, 22, "Port"),
            },
            "RoyalVNCConnection"
            | "RoyalWebConnection"
            | "RoyalTerminalServicesConnection"
            | "RoyalTeamViewerConnection" => {
                parsed.warnings.push(format!(
                    "{name}: {} objects are not supported",
                    object.kind.trim_start_matches("Royal")
                ));
                continue;
            }
            _ => continue,
        };
        let Some(folder) = folder_of(object) else {
            continue;
        };
        let Some(hostname) = object.get("URI") else {
            continue;
        };
        let (username, key_path) = credentials(object);
        parsed.hosts.push(ImportedHost {
            name,
            hostname: hostname.to_string(),
            port: object
                .get(port_field)
                .and_then(|p| p.parse().ok())
                .filter(|p| *p > 0)
                .unwrap_or(default_port),
            username: username.unwrap_or_default(),
            protocol,
            folder,
            key_path: key_path.filter(|_| protocol == Protocol::Ssh),
            color: colour_of(object),
            ..ImportedHost::default()
        });
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_connections_folders_credentials_and_colours() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<RTSZDocument>
  <RoyalDocument><ID>d0c</ID><Name>Hostealo</Name></RoyalDocument>
  <RoyalFolder><ID>f1</ID><Name>Producción</Name><ParentID>d0c</ParentID><Color>#FF0000</Color>
    <CredentialMode>3</CredentialMode><CredentialId>c1</CredentialId></RoyalFolder>
  <RoyalFolder><ID>f2</ID><Name>Windows</Name><ParentID>f1</ParentID></RoyalFolder>
  <RoyalCredential><ID>c1</ID><Name>root-prod</Name><UserName>root</UserName><Password>encrypted</Password><ParentID>d0c</ParentID></RoyalCredential>
  <RoyalCredential><ID>c2</ID><Name>admin-ad</Name><UserName>CORP\admin</UserName><ParentID>d0c</ParentID></RoyalCredential>
  <RoyalSSHConnection><ID>s1</ID><Name>web01</Name><URI>web01.example.com</URI><Port>2222</Port><ConnectionType>ssh;SSH</ConnectionType>
    <CredentialMode>1</CredentialMode><CredentialKeyFile>~/.ssh/id_ed25519</CredentialKeyFile><ParentID>f1</ParentID></RoyalSSHConnection>
  <RoyalRDSConnection><ID>r1</ID><Name>dc01</Name><URI>10.0.0.9</URI><RDPPort>0</RDPPort>
    <CredentialMode>4</CredentialMode><CredentialName>admin-ad</CredentialName><ParentID>{f2}</ParentID></RoyalRDSConnection>
  <RoyalFileTransferConnection><ID>t1</ID><Name>files</Name><URI>files.example.com</URI><Protocol>3</Protocol>
    <CredentialMode>2</CredentialMode><CredentialUsername>deploy</CredentialUsername><ParentID>d0c</ParentID><Color>#22c55e</Color></RoyalFileTransferConnection>
  <RoyalSSHConnection><ID>s2</ID><Name>switch</Name><URI>192.168.1.2</URI><ConnectionType>telnet;Telnet</ConnectionType><ParentID>d0c</ParentID></RoyalSSHConnection>
  <RoyalTrash><ID>tr</ID><ParentID>d0c</ParentID></RoyalTrash>
  <RoyalSSHConnection><ID>s3</ID><Name>old</Name><URI>old.example.com</URI><ParentID>tr</ParentID></RoyalSSHConnection>
</RTSZDocument>"#;
        let parsed = parse(xml).unwrap();
        let hosts: Vec<_> = parsed
            .hosts
            .iter()
            .map(|h| {
                (
                    h.name.as_str(),
                    h.protocol,
                    h.port,
                    h.username.as_str(),
                    h.folder.as_deref(),
                    h.color.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            hosts,
            [
                (
                    "web01",
                    Protocol::Ssh,
                    2222,
                    "root",
                    Some("Producción"),
                    Some("red")
                ),
                (
                    "dc01",
                    Protocol::Rdp,
                    3389,
                    "CORP\\admin",
                    Some("Producción/Windows"),
                    Some("red")
                ),
                ("files", Protocol::Ssh, 22, "deploy", None, Some("green")),
            ]
        );
        assert_eq!(
            parsed.hosts[0].key_path.as_deref(),
            Some("~/.ssh/id_ed25519")
        );
        assert!(parsed.warnings.iter().any(|w| w.contains("telnet")));
        assert!(looks_like(xml));
    }

    #[test]
    fn old_and_encrypted_documents_are_explained() {
        assert!(
            parse("<NewDataSet><KeyValuePairs/></NewDataSet>")
                .unwrap_err()
                .contains("old format")
        );
    }
}
