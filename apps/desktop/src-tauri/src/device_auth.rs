//! Confirms that the person at the computer is its owner (Touch ID or the account password)
//! before a saved secret is shown. macOS only for now; elsewhere the OS keychain is the gate.

/// `Err("cancelled")` when the user dismisses the dialog.
#[cfg(target_os = "macos")]
pub async fn confirm_owner(reason: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use block2::RcBlock;
        use objc2::runtime::Bool;
        use objc2_foundation::{NSError, NSString};
        use objc2_local_authentication::{LAContext, LAPolicy};

        let policy = LAPolicy::DeviceOwnerAuthentication;
        // The context lives on this thread until the answer comes (it is not Send).
        let context = unsafe { LAContext::new() };
        // No Touch ID and no account password to ask for: the keychain is the only gate.
        if unsafe { context.canEvaluatePolicy_error(policy) }.is_err() {
            return Ok(());
        }
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let reply = RcBlock::new(move |success: Bool, error: *mut NSError| {
            let result = if success.as_bool() {
                Ok(())
            } else {
                match unsafe { error.as_ref() } {
                    // User, system or app cancelled (LAError -2, -4, -9).
                    Some(error) if matches!(error.code(), -2 | -4 | -9) => Err("cancelled".into()),
                    Some(error) => Err(error.localizedDescription().to_string()),
                    None => Err("not confirmed".into()),
                }
            };
            let _ = tx.send(result);
        });
        unsafe {
            context.evaluatePolicy_localizedReason_reply(
                policy,
                &NSString::from_str(&reason),
                &reply,
            )
        };
        rx.recv().map_err(|_| "not confirmed".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "macos"))]
pub async fn confirm_owner(_reason: String) -> Result<(), String> {
    Ok(())
}
