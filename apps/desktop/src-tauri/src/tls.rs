//! TLS server certificates for FTPS and RDP.
//!
//! Certificates are verified against the system roots. When that fails (self-signed, issued for
//! another name: normal for RDP and shared hosting), the user sees the fingerprint and can trust
//! that exact certificate, which is then remembered (trust on first use, like FileZilla and
//! mstsc). Trusted fingerprints live in `tls_certificates.json`, keyed by `protocol:host:port`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone)]
pub struct RejectedCertificate {
    pub fingerprint: String,
    pub reason: String,
}

/// Error returned when the server certificate is neither valid nor trusted by the user.
#[derive(Debug)]
pub struct UntrustedCertificate(pub RejectedCertificate);

impl std::fmt::Display for UntrustedCertificate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "untrusted certificate: {}", self.0.reason)
    }
}

impl std::error::Error for UntrustedCertificate {}

/// SHA-256 of the certificate, as colon-separated hex (the format FileZilla and browsers show).
pub fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Accepts certificates valid for the host, or the one certificate the user chose to trust.
/// Records the last rejected certificate so the user can be asked about it.
#[derive(Debug)]
pub struct TrustOnFirstUse {
    webpki: Option<Arc<WebPkiServerVerifier>>,
    provider: Arc<CryptoProvider>,
    trusted: Option<String>,
    rejected: Mutex<Option<RejectedCertificate>>,
}

impl TrustOnFirstUse {
    fn new(trusted: Option<String>) -> Self {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let mut roots = RootCertStore::empty();
        for cert in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(cert);
        }
        // Without system roots every certificate goes through the fingerprint prompt.
        let webpki = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
            .build()
            .ok();
        Self {
            webpki,
            provider,
            trusted,
            rejected: Mutex::new(None),
        }
    }

    /// The certificate that failed verification in the last handshake, if any.
    pub fn take_rejected(&self) -> Option<RejectedCertificate> {
        self.rejected
            .lock()
            .ok()
            .and_then(|mut rejected| rejected.take())
    }
}

impl ServerCertVerifier for TrustOnFirstUse {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fingerprint = fingerprint(end_entity);
        if self.trusted.as_deref() == Some(fingerprint.as_str()) {
            return Ok(ServerCertVerified::assertion());
        }
        let result = match &self.webpki {
            Some(webpki) => webpki.verify_server_cert(
                end_entity,
                intermediates,
                server_name,
                ocsp_response,
                now,
            ),
            None => Err(rustls::Error::General("no system root certificates".into())),
        };
        if let Err(error) = &result
            && let Ok(mut rejected) = self.rejected.lock()
        {
            *rejected = Some(RejectedCertificate {
                fingerprint,
                reason: error.to_string(),
            });
        }
        result
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// TLS client configuration that verifies with [`TrustOnFirstUse`].
pub fn client_config(
    trusted: Option<String>,
) -> Result<(Arc<ClientConfig>, Arc<TrustOnFirstUse>), rustls::Error> {
    let verifier = Arc::new(TrustOnFirstUse::new(trusted));
    let config = ClientConfig::builder_with_provider(verifier.provider.clone())
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(verifier.clone())
        .with_no_client_auth();
    Ok((Arc::new(config), verifier))
}

/// Fingerprints of the certificates the user chose to trust.
#[derive(Debug, Clone)]
pub struct TrustStore {
    path: PathBuf,
}

impl TrustStore {
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(Self::at(dir.join("tls_certificates.json")))
    }

    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    fn read(&self) -> HashMap<String, String> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.read().remove(key)
    }

    pub fn set(&self, key: &str, fingerprint: &str) -> std::io::Result<()> {
        let mut all = self.read();
        all.insert(key.to_string(), fingerprint.to_string());
        std::fs::write(&self.path, serde_json::to_string_pretty(&all)?)
    }
}
