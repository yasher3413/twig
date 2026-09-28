//! Being the Mac's default browser.
//!
//! macOS decides which app opens web links; an app can only ask. Asking
//! (`make_default_browser`) makes macOS show its own "change your default
//! web browser?" prompt - twig never switches it silently. The bundle's
//! Info.plist is what puts twig on the list in the first place.

#[tauri::command]
pub fn is_default_browser() -> bool {
    imp::is_default()
}

#[tauri::command]
pub fn make_default_browser() -> Result<(), String> {
    imp::make_default()
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSString, NSURL};

    /// This app's bundle, or None when running unbundled (`tauri dev`),
    /// which macOS can't register as anything.
    fn this_app() -> Option<Retained<NSURL>> {
        let url = NSBundle::mainBundle().bundleURL();
        url.path()?.to_string().ends_with(".app").then_some(url)
    }

    pub fn is_default() -> bool {
        let (Some(me), Some(probe)) = (this_app(), NSURL::URLWithString(&NSString::from_str("https://example.com")))
        else {
            return false;
        };
        let handler = NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(&probe);
        match (handler.and_then(|h| h.path()), me.path()) {
            (Some(a), Some(b)) => a.to_string() == b.to_string(),
            _ => false,
        }
    }

    pub fn make_default() -> Result<(), String> {
        let me = this_app().ok_or(
            "Only the installed twig app can be your default browser. Build it with `npm run tauri build` and open that copy.",
        )?;
        // Setting http is what the system prompt is about; accepting it makes
        // twig the default web browser, https included.
        NSWorkspace::sharedWorkspace().setDefaultApplicationAtURL_toOpenURLsWithScheme_completionHandler(
            &me,
            &NSString::from_str("http"),
            None,
        );
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn is_default() -> bool {
        false
    }
    pub fn make_default() -> Result<(), String> {
        Err("Setting the default browser is only supported on macOS.".into())
    }
}
