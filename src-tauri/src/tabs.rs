use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, State, Webview,
    WebviewBuilder, WebviewUrl, Window, WindowEvent,
};

/// Width, in logical pixels, reserved on the left edge of the window for the
/// sidebar chrome (vertical tab list, spaces, etc). Tab content webviews are
/// positioned to the right of this strip so the two never overlap.
pub const SIDEBAR_WIDTH: f64 = 240.0;

/// How many tabs are allowed to stay "hot" (a live webview) at once. Opening
/// or activating a tab beyond this count hibernates the least-recently-used
/// hot tab. Not user-configurable yet; that'll come with the settings UI.
const MAX_HOT_TABS: usize = 5;

/// How long a hot, non-active tab can sit idle before it's hibernated on its
/// own, independent of the LRU cap above. Not user-configurable yet.
const HIBERNATE_AFTER: Duration = Duration::from_secs(10 * 60);

/// How often the background sweep checks for idle tabs to hibernate.
const IDLE_SWEEP_INTERVAL: Duration = Duration::from_secs(30);

const MAIN_WINDOW_LABEL: &str = "main";
const DEFAULT_TAB_URL: &str = "about:blank";
const DEFAULT_TAB_TITLE: &str = "New Tab";

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum TabStatus {
    /// Has a live webview.
    Hot,
    /// Webview has been torn down; only metadata + scroll position remain.
    /// Recreated on demand the moment the tab is activated again.
    Hibernated,
}

#[derive(Clone, Serialize, Debug)]
pub struct TabInfo {
    pub id: String,
    pub url: String,
    pub title: String,
    pub status: TabStatus,
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
    status: TabStatus,
    last_active_at: Instant,
    /// Scroll offset captured right before hibernating, restored on wake.
    scroll_y: f64,
}

impl TabEntry {
    fn to_info(&self) -> TabInfo {
        TabInfo {
            id: self.id.clone(),
            url: self.url.clone(),
            title: self.title.clone(),
            status: self.status,
        }
    }
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
            tabs: self.tabs.iter().map(TabEntry::to_info).collect(),
            active_id: self.active_id.clone(),
        }
    }
}

/// Owns the set of open tabs and the webview backing each one. Only tabs
/// marked `Hot` have a live webview; `Hibernated` tabs are just metadata
/// until they're activated again.
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

/// Creates the webview backing a tab. If `scroll_y` is non-zero, injects a
/// script that restores that scroll offset once the page's DOM is ready
/// (used when waking a hibernated tab back up).
fn spawn_webview<R: Runtime>(
    window: &Window<R>,
    label: &str,
    url: tauri::Url,
    scroll_y: f64,
) -> tauri::Result<Webview<R>> {
    let (position, size) = content_bounds(window)?;
    let mut builder = WebviewBuilder::new(label, WebviewUrl::External(url));
    if scroll_y > 0.0 {
        builder = builder.initialization_script(format!(
            "window.addEventListener('DOMContentLoaded', function () {{ window.scrollTo(0, {scroll_y}); }});"
        ));
    }
    window.add_child(builder, position, size)
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

/// Best-effort scroll position read, used right before tearing a webview
/// down. Bounded by a short timeout so a slow or wedged page can't hang the
/// hibernation path.
fn capture_scroll<R: Runtime>(webview: &Webview<R>) -> Result<f64, String> {
    let (tx, rx) = mpsc::channel();
    webview
        .eval_with_callback("window.scrollY", move |result| {
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    let raw = rx
        .recv_timeout(Duration::from_millis(500))
        .map_err(|e| e.to_string())?;
    raw.parse::<f64>().map_err(|e| e.to_string())
}

/// Tears down a hot tab's webview, capturing its scroll position first on a
/// best-effort basis. No-op if the tab is already hibernated.
fn hibernate<R: Runtime>(app: &AppHandle<R>, entry: &mut TabEntry) {
    if entry.status == TabStatus::Hibernated {
        return;
    }
    let label = tab_label(&entry.id);
    if let Some(webview) = app.get_webview(&label) {
        if let Ok(y) = capture_scroll(&webview) {
            entry.scroll_y = y;
        }
        let _ = webview.close();
    }
    entry.status = TabStatus::Hibernated;
}

/// Makes sure a tab has a live webview (recreating it if it was hibernated),
/// shows it, and marks it as just-viewed.
fn wake_and_show<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    inner: &mut Inner,
    id: &str,
) -> Result<(), String> {
    let entry = inner
        .tabs
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("no such tab: {id}"))?;

    if entry.status == TabStatus::Hibernated {
        let label = tab_label(id);
        let parsed: tauri::Url = entry.url.parse().map_err(|e| format!("invalid url: {e}"))?;
        spawn_webview(window, &label, parsed, entry.scroll_y).map_err(|e| e.to_string())?;
    }
    entry.status = TabStatus::Hot;
    entry.last_active_at = Instant::now();

    show_tab(app, window, &tab_label(id)).map_err(|e| e.to_string())
}

/// Hibernates hot tabs beyond `MAX_HOT_TABS`, oldest-viewed first, always
/// keeping `keep_id` (the tab that was just made active) alive.
fn enforce_hot_cap<R: Runtime>(app: &AppHandle<R>, inner: &mut Inner, keep_id: &str) {
    loop {
        let hot_count = inner.tabs.iter().filter(|t| t.status == TabStatus::Hot).count();
        if hot_count <= MAX_HOT_TABS {
            return;
        }
        let oldest = inner
            .tabs
            .iter()
            .filter(|t| t.status == TabStatus::Hot && t.id != keep_id)
            .min_by_key(|t| t.last_active_at)
            .map(|t| t.id.clone());
        let Some(oldest_id) = oldest else {
            return;
        };
        if let Some(entry) = inner.tabs.iter_mut().find(|t| t.id == oldest_id) {
            hibernate(app, entry);
        }
    }
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

    spawn_webview(&window, &label, parsed, 0.0).map_err(|e| e.to_string())?;

    if let Some(active) = &inner.active_id {
        hide_tab(&app, &tab_label(active)).map_err(|e| e.to_string())?;
    }

    inner.tabs.push(TabEntry {
        id: id.clone(),
        url,
        title: DEFAULT_TAB_TITLE.to_string(),
        status: TabStatus::Hot,
        last_active_at: Instant::now(),
        scroll_y: 0.0,
    });
    inner.active_id = Some(id.clone());
    enforce_hot_cap(&app, &mut inner, &id);

    let info = inner
        .tabs
        .iter()
        .find(|t| t.id == id)
        .map(TabEntry::to_info)
        .expect("tab was just inserted");

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

    if inner.active_id.as_deref() == Some(id.as_str()) {
        return Ok(());
    }
    if !inner.tabs.iter().any(|t| t.id == id) {
        return Err(format!("no such tab: {id}"));
    }

    if let Some(prev) = inner.active_id.clone() {
        hide_tab(&app, &tab_label(&prev)).map_err(|e| e.to_string())?;
    }
    wake_and_show(&app, &window, &mut inner, &id)?;
    inner.active_id = Some(id.clone());
    enforce_hot_cap(&app, &mut inner, &id);

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
        if let Some(next_id) = &next_id {
            wake_and_show(&app, &window, &mut inner, next_id)?;
        }
    }

    if let Some(active) = inner.active_id.clone() {
        enforce_hot_cap(&app, &mut inner, &active);
    }

    emit_tabs_changed(&app, &inner);
    Ok(())
}

#[tauri::command]
pub fn list_tabs(manager: State<'_, TabManager>) -> TabsChangedPayload {
    manager.0.lock().unwrap().snapshot()
}

/// Moves the tab to `to_index`, where `to_index` is expressed in terms of
/// the list *before* the move (so `tabs.len()` means "move to the end").
#[tauri::command]
pub fn reorder_tab<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, TabManager>,
    id: String,
    to_index: usize,
) -> Result<(), String> {
    let mut inner = manager.0.lock().unwrap();
    let from = inner
        .tabs
        .iter()
        .position(|t| t.id == id)
        .ok_or_else(|| format!("no such tab: {id}"))?;

    let entry = inner.tabs.remove(from);
    let mut target = to_index.min(inner.tabs.len() + 1);
    if target > from {
        target -= 1;
    }
    let target = target.min(inner.tabs.len());
    inner.tabs.insert(target, entry);

    emit_tabs_changed(&app, &inner);
    Ok(())
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

/// Background sweep that hibernates hot, non-active tabs once they've sat
/// idle longer than `HIBERNATE_AFTER`. Runs for the lifetime of the app.
pub fn watch_idle_tabs<R: Runtime>(app: &AppHandle<R>) {
    let app_handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(IDLE_SWEEP_INTERVAL);

        let manager = app_handle.state::<TabManager>();
        let mut inner = manager.0.lock().unwrap();
        let active_id = inner.active_id.clone();
        let now = Instant::now();

        let stale: Vec<String> = inner
            .tabs
            .iter()
            .filter(|t| t.status == TabStatus::Hot)
            .filter(|t| Some(t.id.as_str()) != active_id.as_deref())
            .filter(|t| now.duration_since(t.last_active_at) > HIBERNATE_AFTER)
            .map(|t| t.id.clone())
            .collect();

        if stale.is_empty() {
            continue;
        }
        for id in &stale {
            if let Some(entry) = inner.tabs.iter_mut().find(|t| &t.id == id) {
                hibernate(&app_handle, entry);
            }
        }
        emit_tabs_changed(&app_handle, &inner);
    });
}
