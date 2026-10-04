//! Pictures of the pages on screen, for twig's own interface to show in
//! their place while an overlay is up.
//!
//! Tab pages are native views drawn above twig's interface, so nothing twig
//! draws can sit on top of them. Overlays used to hide the page instead,
//! which turned the window dark behind Settings and pushed pages around
//! under search suggestions. With a snapshot, the page stays in view - as a
//! still picture - behind whatever is open.

use super::{inner_for, tab_label, visible_ids, TabManager};
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, Window};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PageSnapshot {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    image: String,
}

/// Snapshots every visible tab (both panes in split view) with where it
/// sits in the window, in logical pixels. A page that can't be captured in
/// time is simply left out; the overlay still opens.
#[tauri::command]
pub async fn snapshot_visible_tabs<R: Runtime>(app: AppHandle<R>, window: Window<R>) -> Vec<PageSnapshot> {
    let ids = {
        let manager = app.state::<TabManager>();
        let mut managers = manager.0.lock().unwrap();
        visible_ids(inner_for(&mut managers, &window))
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let mut snapshots = Vec::new();
    for id in ids {
        let Some(webview) = app.get_webview(&tab_label(&id)) else { continue };
        let (Ok(position), Ok(size)) = (webview.position(), webview.size()) else { continue };
        let Some(image) = capture(&webview).await else { continue };
        snapshots.push(PageSnapshot {
            x: position.x as f64 / scale,
            y: position.y as f64 / scale,
            width: size.width as f64 / scale,
            height: size.height as f64 / scale,
            image,
        });
    }
    snapshots
}

#[cfg(target_os = "macos")]
async fn capture<R: Runtime>(webview: &tauri::Webview<R>) -> Option<String> {
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;
    use objc2_web_kit::WKWebView;

    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    webview
        .with_webview(move |platform| {
            let page = unsafe { &*platform.inner().cast::<WKWebView>() };
            let done = block2::RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                let _ = tx.send(unsafe { image.as_ref() }.and_then(jpeg_data_url));
            });
            unsafe { page.takeSnapshotWithConfiguration_completionHandler(None, &done) };
        })
        .ok()?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_millis(600)).ok().flatten())
        .await
        .ok()
        .flatten()
}

#[cfg(not(target_os = "macos"))]
async fn capture<R: Runtime>(_webview: &tauri::Webview<R>) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn jpeg_data_url(image: &objc2_app_kit::NSImage) -> Option<String> {
    use base64::Engine;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    let tiff = image.TIFFRepresentation()?;
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)?;
    let jpeg = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::JPEG, &NSDictionary::new()) }?;
    Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg.to_vec())))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use objc2::AllocAnyThread;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSString;

    #[test]
    fn a_page_picture_becomes_an_image_twig_can_show() {
        let path = NSString::from_str(concat!(env!("CARGO_MANIFEST_DIR"), "/icons/128x128.png"));
        let image = NSImage::initWithContentsOfFile(NSImage::alloc(), &path).expect("icon loads");
        let url = super::jpeg_data_url(&image).expect("encodes");
        assert!(url.starts_with("data:image/jpeg;base64,/9j/"), "{}", &url[..40.min(url.len())]);
    }
}
