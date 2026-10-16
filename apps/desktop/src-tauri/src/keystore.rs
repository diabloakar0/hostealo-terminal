//! The OS credential store behind `secrets` and the Hostealo API key.
//!
//! On desktop it is the store `keyring` picks: the macOS keychain, the Windows Credential
//! Manager or the Secret Service. `keyring` has none for iOS, so there the app installs the iOS
//! keychain itself (the "protected data" store, items kept on this device, not in iCloud).

#[cfg(not(target_os = "ios"))]
pub use keyring::{Entry, Error};
#[cfg(target_os = "ios")]
pub use keyring_core::{Entry, Error};

/// The keychain item for `user` under `service`.
pub fn entry(service: &str, user: &str) -> Result<Entry, Error> {
    #[cfg(target_os = "ios")]
    {
        static STORE: std::sync::Once = std::sync::Once::new();
        STORE.call_once(|| {
            if let Ok(store) = apple_native_keyring_store::protected::Store::new() {
                keyring_core::set_default_store(store);
            }
        });
    }
    Entry::new(service, user)
}
