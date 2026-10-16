//! The system share sheet for local files (iPhone and iPad): save to Files, AirDrop, Mail...
//! Desktop has Finder and Explorer for that, so there the command just says it is not there.

/// Shows the share sheet for `paths` (files in the app's folders).
#[tauri::command]
pub async fn share_files(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    #[cfg(target_os = "ios")]
    {
        // UIKit is main-thread only.
        app.run_on_main_thread(move || present(&paths))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err("sharing is only available on iPhone and iPad".into())
    }
}

#[cfg(target_os = "ios")]
fn present(paths: &[String]) {
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSArray, NSString, NSURL};
    use objc2_ui_kit::{UIActivityViewController, UIApplication};

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let urls: Vec<Retained<NSURL>> = paths
        .iter()
        .map(|path| NSURL::fileURLWithPath(&NSString::from_str(path)))
        .collect();
    let items = NSArray::from_retained_slice(&urls);
    // SAFETY: an array of URLs is an array of objects, which is what the sheet takes.
    let items: Retained<NSArray> = unsafe { Retained::cast_unchecked(items) };
    let app = UIApplication::sharedApplication(mtm);
    #[allow(deprecated)]
    let window = app.keyWindow().or_else(|| app.windows().firstObject());
    let Some(root) = window.and_then(|window| window.rootViewController()) else {
        return;
    };
    // SAFETY: the items are NSURLs, which the share sheet accepts.
    let sheet = unsafe {
        UIActivityViewController::initWithActivityItems_applicationActivities(
            mtm.alloc(),
            &items,
            None,
        )
    };
    // On iPad the sheet is a popover and needs an anchor: the middle of the screen.
    if let (Some(popover), Some(view)) = (sheet.popoverPresentationController(), root.view()) {
        let bounds = view.bounds();
        popover.setSourceView(Some(&view));
        popover.setSourceRect(CGRect::new(
            CGPoint::new(bounds.size.width / 2.0, bounds.size.height / 2.0),
            CGSize::new(1.0, 1.0),
        ));
    }
    root.presentViewController_animated_completion(&sheet, true, None);
}
