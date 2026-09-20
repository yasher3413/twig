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

/// Gap, in logical pixels, between the two panes in split view.
const SPLIT_GAP: f64 = 1.0;

/// How many tabs are allowed to stay "hot" (a live webview) at once, across
/// *all* spaces combined. Opening or activating a tab beyond this count
/// hibernates the least-recently-used hot tab. Not user-configurable yet;
/// that'll come with the settings UI.
const MAX_HOT_TABS: usize = 5;

/// How long a hot tab can sit outside the current space's view before it's
/// hibernated on its own, independent of the LRU cap above. Not
/// user-configurable yet.
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
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub id: String,
    pub url: String,
    pub title: String,
    pub status: TabStatus,
    pub group_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabsChangedPayload {
    pub tabs: Vec<TabInfo>,
    pub active_id: Option<String>,
    pub split_id: Option<String>,
    pub groups: Vec<GroupInfo>,
    pub active_group_id: String,
}

struct TabEntry {
    id: String,
    url: String,
    title: String,
    status: TabStatus,
    last_active_at: Instant,
    /// Scroll offset captured right before hibernating, restored on wake.
    scroll_y: f64,
    group_id: String,
}

impl TabEntry {
    fn to_info(&self) -> TabInfo {
        TabInfo {
            id: self.id.clone(),
            url: self.url.clone(),
            title: self.title.clone(),
            status: self.status,
            group_id: self.group_id.clone(),
        }
    }
}

/// A "space": an independent set of tabs with its own remembered active tab
/// and split partner. Switching spaces swaps which tabs are on screen, but
/// doesn't hibernate anything by itself - the global hot-tab cap and idle
/// sweep (which only protect the *current* space's visible tabs) take care
/// of reclaiming memory from tabs left behind in other spaces over time.
struct Group {
    id: String,
    name: String,
    active_id: Option<String>,
    split_id: Option<String>,
}

struct Inner {
    tabs: Vec<TabEntry>,
    groups: Vec<Group>,
    active_group_id: String,
    next_id: u64,
    next_group_id: u64,
}

impl Default for Inner {
    fn default() -> Self {
        let first_group = Group {
            id: "1".to_string(),
            name: "Space 1".to_string(),
            active_id: None,
            split_id: None,
        };
        Inner {
            tabs: Vec::new(),
            groups: vec![first_group],
            active_group_id: "1".to_string(),
            next_id: 0,
            next_group_id: 1,
        }
    }
}

impl Inner {
    fn group(&self, id: &str) -> Option<&Group> {
        self.groups.iter().find(|g| g.id == id)
    }

    fn group_mut(&mut self, id: &str) -> Option<&mut Group> {
        self.groups.iter_mut().find(|g| g.id == id)
    }

    fn active_group(&self) -> &Group {
        self.group(&self.active_group_id)
            .expect("active group must exist")
    }

    fn active_group_mut(&mut self) -> &mut Group {
        let id = self.active_group_id.clone();
        self.group_mut(&id).expect("active group must exist")
    }

    fn snapshot(&self) -> TabsChangedPayload {
        let active = self.active_group();
        TabsChangedPayload {
            tabs: self.tabs.iter().map(TabEntry::to_info).collect(),
            active_id: active.active_id.clone(),
            split_id: active.split_id.clone(),
            groups: self
                .groups
                .iter()
                .map(|g| GroupInfo {
                    id: g.id.clone(),
                    name: g.name.clone(),
                })
                .collect(),
            active_group_id: self.active_group_id.clone(),
        }
    }
}

/// Owns the set of open tabs, the spaces they're grouped into, and the
/// webview backing each hot tab. Only tabs marked `Hot` have a live webview;
/// `Hibernated` tabs are just metadata until they're activated again.
pub struct TabManager(Mutex<Inner>);

impl TabManager {
    pub fn new() -> Self {
        Self(Mutex::new(Inner::default()))
    }
}

fn tab_label(id: &str) -> String {
    format!("tab-{id}")
}

/// The window area to the right of the sidebar, available for tab content.
fn content_area<R: Runtime>(window: &Window<R>) -> tauri::Result<LogicalSize<f64>> {
    let scale = window.scale_factor()?;
    let logical = window.inner_size()?.to_logical::<f64>(scale);
    Ok(LogicalSize::new(
        (logical.width - SIDEBAR_WIDTH).max(0.0),
        logical.height,
    ))
}

fn content_bounds<R: Runtime>(
    window: &Window<R>,
) -> tauri::Result<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let area = content_area(window)?;
    Ok((LogicalPosition::new(SIDEBAR_WIDTH, 0.0), area))
}

/// Left/right bounds for the two panes in split view.
fn split_bounds<R: Runtime>(
    window: &Window<R>,
) -> tauri::Result<(
    (LogicalPosition<f64>, LogicalSize<f64>),
    (LogicalPosition<f64>, LogicalSize<f64>),
)> {
    let area = content_area(window)?;
    let half = ((area.width - SPLIT_GAP) / 2.0).max(0.0);
    let left = (LogicalPosition::new(SIDEBAR_WIDTH, 0.0), LogicalSize::new(half, area.height));
    let right = (
        LogicalPosition::new(SIDEBAR_WIDTH + half + SPLIT_GAP, 0.0),
        LogicalSize::new(half, area.height),
    );
    Ok((left, right))
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

fn hide_tab<R: Runtime>(app: &AppHandle<R>, label: &str) -> tauri::Result<()> {
    if let Some(webview) = app.get_webview(label) {
        webview.hide()?;
    }
    Ok(())
}

fn place<R: Runtime>(app: &AppHandle<R>, id: &str, bounds: (LogicalPosition<f64>, LogicalSize<f64>)) {
    if let Some(webview) = app.get_webview(&tab_label(id)) {
        let _ = webview.set_position(bounds.0);
        let _ = webview.set_size(bounds.1);
        let _ = webview.show();
    }
}

/// Single source of truth for what's on screen: positions and shows the
/// active group's `active_id` (and `split_id`, side by side, if set).
/// Anything being replaced needs to be hidden by the caller first - this
/// only handles what *should* now be visible.
fn sync_visible_webviews<R: Runtime>(app: &AppHandle<R>, window: &Window<R>, inner: &Inner) {
    let group = inner.active_group();
    match &group.split_id {
        Some(split_id) => {
            let Ok((left, right)) = split_bounds(window) else {
                return;
            };
            if let Some(active) = &group.active_id {
                place(app, active, left);
            }
            place(app, split_id, right);
        }
        None => {
            let Ok(bounds) = content_bounds(window) else {
                return;
            };
            if let Some(active) = &group.active_id {
                place(app, active, bounds);
            }
        }
    }
}

fn focus_active<R: Runtime>(app: &AppHandle<R>, inner: &Inner) {
    if let Some(id) = &inner.active_group().active_id {
        if let Some(webview) = app.get_webview(&tab_label(id)) {
            let _ = webview.set_focus();
        }
    }
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

/// Makes sure a tab has a live webview (recreating it if it was hibernated)
/// and marks it as just-viewed. Doesn't touch position or visibility -
/// callers are expected to follow up with `sync_visible_webviews`.
fn wake<R: Runtime>(window: &Window<R>, inner: &mut Inner, id: &str) -> Result<(), String> {
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
    Ok(())
}

/// Hibernates hot tabs beyond `MAX_HOT_TABS`, oldest-viewed first, always
/// keeping `keep_ids` (the tab(s) currently on screen) alive.
fn enforce_hot_cap<R: Runtime>(app: &AppHandle<R>, inner: &mut Inner, keep_ids: &[String]) {
    loop {
        let hot_count = inner.tabs.iter().filter(|t| t.status == TabStatus::Hot).count();
        if hot_count <= MAX_HOT_TABS {
            return;
        }
        let oldest = inner
            .tabs
            .iter()
            .filter(|t| t.status == TabStatus::Hot && !keep_ids.iter().any(|k| k == &t.id))
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

/// The tab(s) currently on screen: the active space's active tab and, if
/// split view is on, its partner. Everything else is fair game for
/// hibernation, regardless of which space it lives in.
fn visible_ids(inner: &Inner) -> Vec<String> {
    let group = inner.active_group();
    group.active_id.iter().chain(group.split_id.iter()).cloned().collect()
}

/// IDs of every tab belonging to `group_id`, in order.
fn group_tab_ids(inner: &Inner, group_id: &str) -> Vec<String> {
    inner
        .tabs
        .iter()
        .filter(|t| t.group_id == group_id)
        .map(|t| t.id.clone())
        .collect()
}

fn emit_tabs_changed<R: Runtime>(app: &AppHandle<R>, inner: &Inner) {
    let _ = app.emit("tabs-changed", inner.snapshot());
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Result<Window<R>, String> {
    app.get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())
}

/// Switches which space is "current": hides whatever the old space was
/// showing, then wakes (but doesn't yet position/show - callers do that via
/// `sync_visible_webviews`) the new space's remembered active/split tabs.
fn switch_to_group<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    inner: &mut Inner,
    group_id: &str,
) -> Result<(), String> {
    if inner.active_group_id == group_id {
        return Ok(());
    }
    if !inner.groups.iter().any(|g| g.id == group_id) {
        return Err(format!("no such space: {group_id}"));
    }

    for id in visible_ids(inner) {
        hide_tab(app, &tab_label(&id)).map_err(|e| e.to_string())?;
    }

    inner.active_group_id = group_id.to_string();

    let to_wake: Vec<String> = {
        let group = inner.active_group();
        group.active_id.iter().chain(group.split_id.iter()).cloned().collect()
    };
    for id in to_wake {
        wake(window, inner, &id)?;
    }

    Ok(())
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
    let group_id = inner.active_group_id.clone();

    spawn_webview(&window, &label, parsed, 0.0).map_err(|e| e.to_string())?;

    // A new tab always takes over as the sole view - drop any split.
    let (prev_active, prev_split) = {
        let group = inner.active_group();
        (group.active_id.clone(), group.split_id.clone())
    };
    if let Some(active) = prev_active {
        hide_tab(&app, &tab_label(&active)).map_err(|e| e.to_string())?;
    }
    if let Some(split) = prev_split {
        hide_tab(&app, &tab_label(&split)).map_err(|e| e.to_string())?;
    }

    inner.tabs.push(TabEntry {
        id: id.clone(),
        url,
        title: DEFAULT_TAB_TITLE.to_string(),
        status: TabStatus::Hot,
        last_active_at: Instant::now(),
        scroll_y: 0.0,
        group_id,
    });
    {
        let group = inner.active_group_mut();
        group.active_id = Some(id.clone());
        group.split_id = None;
    }
    enforce_hot_cap(&app, &mut inner, &[id.clone()]);

    let info = inner
        .tabs
        .iter()
        .find(|t| t.id == id)
        .map(TabEntry::to_info)
        .expect("tab was just inserted");

    sync_visible_webviews(&app, &window, &inner);
    focus_active(&app, &inner);
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

    let group_id = inner
        .tabs
        .iter()
        .find(|t| t.id == id)
        .map(|t| t.group_id.clone())
        .ok_or_else(|| format!("no such tab: {id}"))?;

    if inner.active_group_id != group_id {
        switch_to_group(&app, &window, &mut inner, &group_id)?;
    }

    let already_sole_active = {
        let group = inner.active_group();
        group.active_id.as_deref() == Some(id.as_str()) && group.split_id.is_none()
    };

    if !already_sole_active {
        // Switching tabs normally always drops back to a single, full view.
        let (prev_active, prev_split) = {
            let group = inner.active_group();
            (group.active_id.clone(), group.split_id.clone())
        };
        if let Some(prev) = prev_active {
            if prev != id {
                hide_tab(&app, &tab_label(&prev)).map_err(|e| e.to_string())?;
            }
        }
        if let Some(prev_split) = prev_split {
            hide_tab(&app, &tab_label(&prev_split)).map_err(|e| e.to_string())?;
        }

        wake(&window, &mut inner, &id)?;
        {
            let group = inner.active_group_mut();
            group.active_id = Some(id.clone());
            group.split_id = None;
        }
        let keep = visible_ids(&inner);
        enforce_hot_cap(&app, &mut inner, &keep);
    }

    sync_visible_webviews(&app, &window, &inner);
    focus_active(&app, &inner);
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
    let group_id = inner.tabs[index].group_id.clone();
    let group_index = inner.tabs[..index].iter().filter(|t| t.group_id == group_id).count();

    if let Some(webview) = app.get_webview(&tab_label(&id)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    inner.tabs.remove(index);

    let was_split = inner.group(&group_id).and_then(|g| g.split_id.as_deref()) == Some(id.as_str());
    let was_active = inner.group(&group_id).and_then(|g| g.active_id.as_deref()) == Some(id.as_str());

    if was_split {
        // The split pane's tab was closed - fall back to a single view.
        inner.group_mut(&group_id).unwrap().split_id = None;
    } else if was_active {
        // The active tab was closed. If it had a split partner, promote that
        // tab to active instead of guessing at a neighbor.
        let promoted = inner.group_mut(&group_id).unwrap().split_id.take();
        if let Some(promoted) = promoted {
            wake(&window, &mut inner, &promoted)?;
            inner.group_mut(&group_id).unwrap().active_id = Some(promoted);
        } else {
            let siblings = group_tab_ids(&inner, &group_id);
            let next_id = siblings
                .get(group_index)
                .or_else(|| group_index.checked_sub(1).and_then(|i| siblings.get(i)))
                .cloned();
            inner.group_mut(&group_id).unwrap().active_id = next_id.clone();
            if let Some(next_id) = &next_id {
                wake(&window, &mut inner, next_id)?;
            }
        }
    }

    let keep = visible_ids(&inner);
    enforce_hot_cap(&app, &mut inner, &keep);

    sync_visible_webviews(&app, &window, &inner);
    focus_active(&app, &inner);
    emit_tabs_changed(&app, &inner);
    Ok(())
}

#[tauri::command]
pub fn list_tabs(manager: State<'_, TabManager>) -> TabsChangedPayload {
    manager.0.lock().unwrap().snapshot()
}

/// Moves the tab to `to_index` *within its own space* - `to_index` is
/// expressed in terms of that space's tab list before the move (so the
/// space's tab count means "move to the end"). Tabs from other spaces can
/// be interleaved with this one in storage order, so the move is computed
/// against the group-local subsequence rather than the raw list index.
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
    let group_id = inner.tabs[from].group_id.clone();

    let group_positions: Vec<usize> = inner
        .tabs
        .iter()
        .enumerate()
        .filter(|(_, t)| t.group_id == group_id)
        .map(|(i, _)| i)
        .collect();

    let insert_at = reorder_insert_index(&group_positions, from, to_index);

    let entry = inner.tabs.remove(from);
    inner.tabs.insert(insert_at, entry);

    emit_tabs_changed(&app, &inner);
    Ok(())
}

/// Given the global indices a space's tabs occupy (before the move) and
/// which of them (`from`) is being dragged to local position `to_index`
/// within that space's own list, returns the global index to insert at
/// after `from` has been removed from the list.
fn reorder_insert_index(group_positions: &[usize], from: usize, to_index: usize) -> usize {
    let from_local = group_positions.iter().position(|&i| i == from).unwrap();

    let mut target_local = to_index.min(group_positions.len());
    if target_local > from_local {
        target_local -= 1;
    }
    let target_local = target_local.min(group_positions.len() - 1);

    // Positions shift down by one wherever they were after `from`, once
    // `from` itself is removed from the underlying list.
    let positions_after: Vec<usize> = group_positions
        .iter()
        .filter(|&&i| i != from)
        .map(|&i| if i > from { i - 1 } else { i })
        .collect();

    positions_after
        .get(target_local)
        .copied()
        .unwrap_or_else(|| positions_after.last().map_or(0, |&i| i + 1))
}

#[cfg(test)]
mod reorder_tests {
    use super::reorder_insert_index;

    #[test]
    fn single_group_move_to_front() {
        // group occupies global positions [0, 1, 2, 3]; drag the last one (3) to the front.
        assert_eq!(reorder_insert_index(&[0, 1, 2, 3], 3, 0), 0);
    }

    #[test]
    fn single_group_move_to_end() {
        assert_eq!(reorder_insert_index(&[0, 1, 2, 3], 0, 4), 3);
    }

    #[test]
    fn single_group_no_op_drop_on_self() {
        assert_eq!(reorder_insert_index(&[0, 1, 2, 3], 1, 1), 1);
    }

    #[test]
    fn interleaved_groups_move_within_group() {
        // This group's tabs sit at global [0, 2, 4]; another group's tabs
        // occupy 1 and 3. Move the group's middle tab (global index 2,
        // local index 1) to local index 0 (front of its own group): after
        // removing index 2, the group's remaining members are at [0, 3], so
        // it should land at global 0.
        assert_eq!(reorder_insert_index(&[0, 2, 4], 2, 0), 0);
        // Move it to the end of its own group instead (to_index == group
        // len == 3): past the group's last remaining member (now at global
        // 3), landing at global 4.
        assert_eq!(reorder_insert_index(&[0, 2, 4], 2, 3), 4);
    }

    #[test]
    fn interleaved_groups_no_op_and_move_to_end() {
        // Dragging local 0 (global 0) to to_index 1 mirrors the flat-list
        // no-op case: inserting "before local index 1's original spot"
        // while dragging *from* local 0 leaves it exactly where it was.
        assert_eq!(reorder_insert_index(&[0, 2, 4], 0, 1), 1);
        // Dragging it all the way to the end of its own group (to_index ==
        // group len == 3) instead moves it past every other group member.
        assert_eq!(reorder_insert_index(&[0, 2, 4], 0, 3), 4);
    }
}

/// Adds `https://` to a bare host/query typed into the command palette
/// (e.g. "example.com") if it doesn't already look like a full URL.
fn normalize_url(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

fn derive_title(url: &tauri::Url) -> String {
    url.host_str().map(str::to_string).unwrap_or_else(|| url.to_string())
}

/// Navigates a tab to a new URL, live if it's hot (otherwise the new URL
/// just takes effect the next time it wakes).
#[tauri::command]
pub fn navigate_tab<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, TabManager>,
    id: String,
    url: String,
) -> Result<TabInfo, String> {
    let parsed: tauri::Url = normalize_url(&url)
        .parse()
        .map_err(|e| format!("invalid url: {e}"))?;

    let mut inner = manager.0.lock().unwrap();
    let entry = inner
        .tabs
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("no such tab: {id}"))?;

    entry.url = parsed.to_string();
    entry.title = derive_title(&parsed);
    entry.scroll_y = 0.0;

    if entry.status == TabStatus::Hot {
        if let Some(webview) = app.get_webview(&tab_label(&id)) {
            webview.navigate(parsed).map_err(|e| e.to_string())?;
        }
    }

    let info = entry.to_info();
    emit_tabs_changed(&app, &inner);
    Ok(info)
}

/// Hides (or restores) the current space's visible webview(s) so
/// full-window chrome overlays (the command palette, and later ones like
/// it) can actually be seen: tab content is a separate, higher native
/// webview that DOM z-index can't draw over.
#[tauri::command]
pub fn set_overlay_active<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, TabManager>,
    open: bool,
) -> Result<(), String> {
    let window = main_window(&app)?;
    let inner = manager.0.lock().unwrap();
    if open {
        for id in visible_ids(&inner) {
            hide_tab(&app, &tab_label(&id)).map_err(|e| e.to_string())?;
        }
        Ok(())
    } else {
        sync_visible_webviews(&app, &window, &inner);
        focus_active(&app, &inner);
        Ok(())
    }
}

/// Sets (or clears, with `id: None`) the tab shown side by side with the
/// active tab. The active tab keeps its role; this only changes its
/// companion pane. The target must belong to the current space.
#[tauri::command]
pub fn set_split<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, TabManager>,
    id: Option<String>,
) -> Result<(), String> {
    let window = main_window(&app)?;
    let mut inner = manager.0.lock().unwrap();

    if let Some(target) = &id {
        match inner.tabs.iter().find(|t| &t.id == target) {
            None => return Err(format!("no such tab: {target}")),
            Some(t) if t.group_id != inner.active_group_id => {
                return Err("cannot split a tab from a different space".to_string());
            }
            _ => {}
        }
        if inner.active_group().active_id.as_deref() == Some(target.as_str()) {
            return Err("cannot split a tab with itself".to_string());
        }
    }

    let current_split = inner.active_group().split_id.clone();
    if current_split != id {
        if let Some(prev) = current_split {
            hide_tab(&app, &tab_label(&prev)).map_err(|e| e.to_string())?;
        }
    }

    if let Some(target) = &id {
        wake(&window, &mut inner, target)?;
    }
    inner.active_group_mut().split_id = id;

    let keep = visible_ids(&inner);
    enforce_hot_cap(&app, &mut inner, &keep);

    sync_visible_webviews(&app, &window, &inner);
    focus_active(&app, &inner);
    emit_tabs_changed(&app, &inner);
    Ok(())
}

/// Creates a new, empty space and switches to it.
#[tauri::command]
pub fn create_group<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, TabManager>,
    name: Option<String>,
) -> Result<GroupInfo, String> {
    let window = main_window(&app)?;
    let mut inner = manager.0.lock().unwrap();

    inner.next_group_id += 1;
    let id = inner.next_group_id.to_string();
    let name = name.unwrap_or_else(|| format!("Space {}", inner.groups.len() + 1));
    inner.groups.push(Group {
        id: id.clone(),
        name: name.clone(),
        active_id: None,
        split_id: None,
    });

    switch_to_group(&app, &window, &mut inner, &id)?;

    sync_visible_webviews(&app, &window, &inner);
    focus_active(&app, &inner);
    emit_tabs_changed(&app, &inner);
    Ok(GroupInfo { id, name })
}

/// Switches to a different space.
#[tauri::command]
pub fn switch_group<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, TabManager>,
    id: String,
) -> Result<(), String> {
    let window = main_window(&app)?;
    let mut inner = manager.0.lock().unwrap();

    switch_to_group(&app, &window, &mut inner, &id)?;

    sync_visible_webviews(&app, &window, &inner);
    focus_active(&app, &inner);
    emit_tabs_changed(&app, &inner);
    Ok(())
}

/// Closes a space and every tab in it. Refuses to close the last remaining
/// space.
#[tauri::command]
pub fn close_group<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, TabManager>,
    id: String,
) -> Result<(), String> {
    let window = main_window(&app)?;
    let mut inner = manager.0.lock().unwrap();

    if !inner.groups.iter().any(|g| g.id == id) {
        return Err(format!("no such space: {id}"));
    }
    if inner.groups.len() == 1 {
        return Err("cannot close the last space".to_string());
    }

    let doomed = group_tab_ids(&inner, &id);
    for tab_id in &doomed {
        if let Some(webview) = app.get_webview(&tab_label(tab_id)) {
            webview.close().map_err(|e| e.to_string())?;
        }
    }
    inner.tabs.retain(|t| t.group_id != id);

    let was_active_group = inner.active_group_id == id;
    let fallback = if was_active_group {
        inner.groups.iter().find(|g| g.id != id).map(|g| g.id.clone())
    } else {
        None
    };
    inner.groups.retain(|g| g.id != id);

    if let Some(fallback) = fallback {
        inner.active_group_id = fallback;
        let to_wake: Vec<String> = {
            let group = inner.active_group();
            group.active_id.iter().chain(group.split_id.iter()).cloned().collect()
        };
        for tab_id in to_wake {
            wake(&window, &mut inner, &tab_id)?;
        }
    }

    let keep = visible_ids(&inner);
    enforce_hot_cap(&app, &mut inner, &keep);

    sync_visible_webviews(&app, &window, &inner);
    focus_active(&app, &inner);
    emit_tabs_changed(&app, &inner);
    Ok(())
}

/// Renames a space.
#[tauri::command]
pub fn rename_group<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, TabManager>,
    id: String,
    name: String,
) -> Result<(), String> {
    let mut inner = manager.0.lock().unwrap();
    let name = name.trim();
    if name.is_empty() {
        return Err("space name cannot be empty".to_string());
    }
    let name = name.to_string();
    inner
        .group_mut(&id)
        .ok_or_else(|| format!("no such space: {id}"))?
        .name = name;
    emit_tabs_changed(&app, &inner);
    Ok(())
}

/// Keeps the visible webview(s) sized to fill the window whenever it
/// resizes (hidden tabs are repositioned lazily when they next become
/// visible instead).
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
        let inner = manager.0.lock().unwrap();
        let Some(window) = app_handle.get_window(MAIN_WINDOW_LABEL) else {
            return;
        };
        sync_visible_webviews(&app_handle, &window, &inner);
    });
}

/// Background sweep that hibernates hot tabs outside the current space's
/// view once they've sat idle longer than `HIBERNATE_AFTER`. Runs for the
/// lifetime of the app.
pub fn watch_idle_tabs<R: Runtime>(app: &AppHandle<R>) {
    let app_handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(IDLE_SWEEP_INTERVAL);

        let manager = app_handle.state::<TabManager>();
        let mut inner = manager.0.lock().unwrap();
        let visible = visible_ids(&inner);
        let now = Instant::now();

        let stale: Vec<String> = inner
            .tabs
            .iter()
            .filter(|t| t.status == TabStatus::Hot)
            .filter(|t| !visible.contains(&t.id))
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
