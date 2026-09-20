use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, State, Webview,
    WebviewBuilder, WebviewUrl, Window, WindowEvent,
};

/// Width, in logical pixels, reserved on the left edge of the window for the
/// sidebar chrome (vertical tab list, spaces, etc). Tab content webviews are
/// positioned to the right of this strip so the two never overlap.
pub const SIDEBAR_WIDTH: f64 = 240.0;

const MAIN_WINDOW_LABEL: &str = "main";
const DEFAULT_TAB_URL: &str = "about:blank";
const DEFAULT_TAB_TITLE: &str = "New Tab";

#[derive(Clone, Serialize)]
pub struct TabInfo {
    pub id: String,
    pub url: String,
    pub title: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabsChangedPayload {
    pub tabs: Vec<TabInfo>,
    pub active_id: Option<String>,
}

struct TabEntry {
    id: String,
    url: String,
    title: String,
}

#[derive(Default)]
struct Inner {
    tabs: Vec<TabEntry>,
    active_id: Option<String>,
    next_id: u64,
}

impl Inner {
    fn snapshot(&self) -> TabsChangedPayload {
        TabsChangedPayload {
            tabs: self
                .tabs
                .iter()
                .map(|t| TabInfo {
                    id: t.id.clone(),
                    url: t.url.clone(),
                    title: t.title.clone(),
                })
                .collect(),
            active_id: self.active_id.clone(),
        }
    }
}

/// Owns the set of open tabs and the webview backing each one. Every tab is a
/// real, separate Tauri webview; only the active tab's webview is shown at a
/// time, the rest sit hidden behind it (hibernation will later tear the
/// hidden ones down entirely instead of just hiding them).
#[derive(Default)]
pub struct TabManager(Mutex<Inner>);

impl TabManager {
    pub fn new() -> Self {
        Self::default()
    }
}

fn tab_label(id: &str) -> String {
    format!("tab-{id}")
}

fn content_bounds<R: Runtime>(
    window: &Window<R>,
) -> tauri::Result<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let scale = window.scale_factor()?;
    let logical = window.inner_size()?.to_logical::<f64>(scale);
    let width = (logical.width - SIDEBAR_WIDTH).max(0.0);
    Ok((
        LogicalPosition::new(SIDEBAR_WIDTH, 0.0),
        LogicalSize::new(width, logical.height),
    ))
}

fn reposition<R: Runtime>(webview: &Webview<R>, window: &Window<R>) -> tauri::Result<()> {
    let (position, size) = content_bounds(window)?;
    webview.set_position(position)?;
    webview.set_size(size)?;
    Ok(())
}

fn show_tab<R: Runtime>(app: &AppHandle<R>, window: &Window<R>, label: &str) -> tauri::Result<()> {
    if let Some(webview) = app.get_webview(label) {
        reposition(&webview, window)?;
        webview.show()?;
        webview.set_focus()?;
    }
    Ok(())
}

fn hide_tab<R: Runtime>(app: &AppHandle<R>, label: &str) -> tauri::Result<()> {
    if let Some(webview) = app.get_webview(label) {
        webview.hide()?;
    }
    Ok(())
}

fn emit_tabs_changed<R: Runtime>(app: &AppHandle<R>, inner: &Inner) {
    let _ = app.emit("tabs-changed", inner.snapshot());
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Result<Window<R>, String> {
    app.get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())
}

#[tauri::command]
pub fn create_tab<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, TabManager>,
    url: Option<String>,
) -> Result<TabInfo, String> {
    let window = main_window(&app)?;
    let url = url.unwrap_or_else(|| DEFAULT_TAB_URL.to_string());
    let parsed = url.parse().map_err(|e| format!("invalid url: {e}"))?;

    let mut inner = manager.0.lock().unwrap();
    inner.next_id += 1;
    let id = inner.next_id.to_string();
    let label = tab_label(&id);

    let (position, size) = content_bounds(&window).map_err(|e| e.to_string())?;
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed));
    window
        .add_child(builder, position, size)
        .map_err(|e| e.to_string())?;

    if let Some(active) = &inner.active_id {
        hide_tab(&app, &tab_label(active)).map_err(|e| e.to_string())?;
    }

    let info = TabInfo {
        id: id.clone(),
        url,
        title: DEFAULT_TAB_TITLE.to_string(),
    };
    inner.tabs.push(TabEntry {
        id: id.clone(),
        url: info.url.clone(),
        title: info.title.clone(),
    });
    inner.active_id = Some(id);

    emit_tabs_changed(&app, &inner);
    Ok(info)
}

#[tauri::command]
pub fn activate_tab<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, TabManager>,
    id: String,
) -> Result<(), String> {
    let window = main_window(&app)?;
    let mut inner = manager.0.lock().unwrap();

    if !inner.tabs.iter().any(|t| t.id == id) {
        return Err(format!("no such tab: {id}"));
    }
    if inner.active_id.as_deref() == Some(id.as_str()) {
        return Ok(());
    }

    if let Some(active) = inner.active_id.clone() {
        hide_tab(&app, &tab_label(&active)).map_err(|e| e.to_string())?;
    }
    show_tab(&app, &window, &tab_label(&id)).map_err(|e| e.to_string())?;
    inner.active_id = Some(id);

    emit_tabs_changed(&app, &inner);
    Ok(())
}

#[tauri::command]
pub fn close_tab<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, TabManager>,
    id: String,
) -> Result<(), String> {
    let window = main_window(&app)?;
    let mut inner = manager.0.lock().unwrap();

    let index = inner
        .tabs
        .iter()
        .position(|t| t.id == id)
        .ok_or_else(|| format!("no such tab: {id}"))?;

    if let Some(webview) = app.get_webview(&tab_label(&id)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    inner.tabs.remove(index);

    if inner.active_id.as_deref() == Some(id.as_str()) {
        let next_id = inner
            .tabs
            .get(index)
            .or_else(|| index.checked_sub(1).and_then(|i| inner.tabs.get(i)))
            .map(|t| t.id.clone());
        inner.active_id = next_id.clone();
        if let Some(next_id) = next_id {
            show_tab(&app, &window, &tab_label(&next_id)).map_err(|e| e.to_string())?;
        }
    }

    emit_tabs_changed(&app, &inner);
    Ok(())
}

#[tauri::command]
pub fn list_tabs(manager: State<'_, TabManager>) -> TabsChangedPayload {
    manager.0.lock().unwrap().snapshot()
}

/// Keeps the active tab's webview sized to fill the window whenever the
/// window itself is resized (hidden tabs are repositioned lazily when they
/// next become active instead).
pub fn watch_window_resize<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        let WindowEvent::Resized(_) = event else {
            return;
        };
        let manager = app_handle.state::<TabManager>();
        let active = manager.0.lock().unwrap().active_id.clone();
        let Some(active) = active else { return };
        let Some(window) = app_handle.get_window(MAIN_WINDOW_LABEL) else {
            return;
        };
        let Some(webview) = app_handle.get_webview(&tab_label(&active)) else {
            return;
        };
        let _ = reposition(&webview, &window);
    });
}
