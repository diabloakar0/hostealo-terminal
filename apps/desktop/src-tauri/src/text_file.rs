//! Text files opened in the file browser's editor, wherever they live (SFTP, FTP, this computer):
//! a size limit, a check that the file is text at all, and an encoding that saves back exactly the
//! bytes it read. Line endings are left to the UI, which keeps them as they were.

use serde::{Deserialize, Serialize};

/// Bigger files are logs or data, not something to edit here.
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Errors the UI recognises (it shows its own text for them).
pub const TOO_LARGE: &str = "too-large";
pub const BINARY: &str = "binary";
/// The file changed since it was opened (someone else saved it).
pub const CHANGED: &str = "changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Encoding {
    Utf8,
    /// UTF-8 starting with a byte order mark, which is written back.
    Utf8Bom,
    /// Anything that is not UTF-8: each byte is one character, so it round-trips unchanged.
    Latin1,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub content: String,
    pub encoding: Encoding,
    /// Seconds since the Unix epoch, to notice changes before saving (`None` when unknown).
    pub modified: Option<u64>,
}

/// Bytes read from a file → its text, refusing what is not text.
pub fn decode(bytes: &[u8]) -> Result<(String, Encoding), String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(TOO_LARGE.into());
    }
    // A NUL byte near the start: an image, an archive, a program...
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Err(BINARY.into());
    }
    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF")
        && let Ok(text) = std::str::from_utf8(rest)
    {
        return Ok((text.to_string(), Encoding::Utf8Bom));
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok((text.to_string(), Encoding::Utf8)),
        Err(_) => Ok((bytes.iter().map(|&b| b as char).collect(), Encoding::Latin1)),
    }
}

/// Text from the editor → the bytes to write, in the file's own encoding.
pub fn encode(content: &str, encoding: Encoding) -> Result<Vec<u8>, String> {
    match encoding {
        Encoding::Utf8 => Ok(content.as_bytes().to_vec()),
        Encoding::Utf8Bom => {
            let mut bytes = b"\xEF\xBB\xBF".to_vec();
            bytes.extend_from_slice(content.as_bytes());
            Ok(bytes)
        }
        Encoding::Latin1 => content
            .chars()
            .map(|c| {
                u8::try_from(u32::from(c)).map_err(|_| {
                    format!("“{c}” cannot be saved in this file's encoding (it is not UTF-8)")
                })
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_encoding_round_trips_its_bytes() {
        for bytes in [
            b"server {\n  listen 80;\n}\n".to_vec(),
            "şarkı = ğüçö\r\n".as_bytes().to_vec(),
            b"\xEF\xBB\xBF[Section]\r\nkey=value\r\n".to_vec(),
            // Windows-1254 Turkish: not UTF-8, kept byte for byte.
            b"ad=\xFE\xF0\xFD\n".to_vec(),
        ] {
            let (text, encoding) = decode(&bytes).unwrap();
            assert_eq!(encode(&text, encoding).unwrap(), bytes, "{encoding:?}");
        }
        assert_eq!(decode(b"\xEF\xBB\xBFa").unwrap().1, Encoding::Utf8Bom);
        assert_eq!(decode(b"a\xFE").unwrap().1, Encoding::Latin1);
    }

    #[test]
    fn binary_and_huge_files_are_refused() {
        assert_eq!(
            decode(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap_err(),
            BINARY
        );
        let huge = vec![b'a'; MAX_BYTES as usize + 1];
        assert_eq!(decode(&huge).unwrap_err(), TOO_LARGE);
    }

    #[test]
    fn latin1_files_reject_characters_they_cannot_hold() {
        assert!(encode("ok é", Encoding::Latin1).is_ok());
        assert!(encode("ş", Encoding::Latin1).is_err());
    }
}
