use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    webview::{Color, DownloadEvent, PageLoadEvent}, AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager,
    Runtime, State, Theme, Webview, WebviewBuilder, WebviewUrl, WebviewWindowBuilder, Window,
    WindowEvent,
};

pub mod checkpoints;
pub mod research;

/// Height, in logical pixels, of the horizontal tab strip. Hidden entirely
/// when `tab_strip_visible` is off, which is what Cmd+B toggles.
pub const TAB_STRIP_HEIGHT: f64 = 38.0;

/// Height, in logical pixels, of the toolbar row holding the omnibox.
/// Always present - it's the only way to type a URL without the palette.
pub const ADDRESS_BAR_HEIGHT: f64 = 46.0;

/// Total chrome the window reserves above tab content. Tab webviews are
/// positioned below this band so the two never overlap.
fn chrome_height(tab_strip_visible: bool) -> f64 {
    ADDRESS_BAR_HEIGHT + if tab_strip_visible { TAB_STRIP_HEIGHT } else { 0.0 }
}

/// Gap, in logical pixels, between the two panes in split view.
const SPLIT_GAP: f64 = 1.0;

/// How many tabs are allowed to stay "hot" (a live webview) at once, across
/// *all* spaces combined, within a single window. Opening or activating a
/// tab beyond this count hibernates the least-recently-used hot tab. Not
/// user-configurable yet; that'll come with the settings UI.
const MAX_HOT_TABS: usize = 5;

/// How long a hot tab can sit outside the current space's view before it's
/// hibernated on its own, independent of the LRU cap above. Not
/// user-configurable yet.
const HIBERNATE_AFTER: Duration = Duration::from_secs(10 * 60);

/// How often the background sweep checks for idle tabs to hibernate.
const IDLE_SWEEP_INTERVAL: Duration = Duration::from_secs(30);

/// How many recently-closed tabs are remembered for reopening.
const CLOSED_STACK_CAP: usize = 20;

pub const MAIN_WINDOW_LABEL: &str = "main";
const DEFAULT_TAB_TITLE: &str = "New Tab";

/// WKWebView's default user agent stops after the AppleWebKit token, with
/// no `Version/… Safari/…` product after it. Sites read that shape as an
/// app embedding a webview rather than a browser: Google serves its no-JS
/// fallback page to it and refuses to let you sign in at all. We render
/// with WebKit, so presenting as Safari is accurate rather than a spoof.
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

/// Injected into every tab so hibernation can ask "would tearing this down
/// lose something?" before it does. A tab counts as busy if it has typing
/// in it that hasn't been submitted, is playing audio or video, or holds a
/// live camera/mic track - the three cases where reclaiming memory would
/// cost the user real work instead of nothing.
const BUSY_TRACKER: &str = r#"(function () {
  if (window.__twigBusyReady) return;
  window.__twigBusyReady = true;
  var dirty = false;
  var streams = [];
  try {
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (!t) return;
      if (t.isContentEditable || (t.matches && t.matches('input,textarea,select'))) dirty = true;
    }, true);
    document.addEventListener('submit', function () { dirty = false; }, true);
  } catch (e) {}
  try {
    var md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      var orig = md.getUserMedia.bind(md);
      md.getUserMedia = function () {
        return orig.apply(null, arguments).then(function (s) { streams.push(s); return s; });
      };
    }
  } catch (e) {}
  function playing() {
    try {
      var els = document.querySelectorAll('video,audio');
      for (var i = 0; i < els.length; i++) {
        var m = els[i];
        if (!m.paused && !m.ended && m.readyState > 2) return true;
      }
    } catch (e) {}
    return false;
  }
  function capturing() {
    try {
      for (var i = 0; i < streams.length; i++) {
        var tr = streams[i].getTracks();
        for (var j = 0; j < tr.length; j++) if (tr[j].readyState === 'live') return true;
      }
    } catch (e) {}
    return false;
  }
  window.__twigBusy = function () { return dirty || playing() || capturing(); };
})();"#;

/// Keyboard link following, the one thing a keyboard-first browser really
/// owes you. Labels every clickable thing in view; type the label to
/// follow it. Deliberately driven by a menu accelerator rather than a bare
/// 'f' keypress, because plenty of sites already bind single letters -
/// 'f' is fullscreen on YouTube - and silently breaking them would be a
/// worse trade than one extra modifier.
const LINK_HINTS: &str = r#"(function () {
  if (window.__twigHintsReady) return;
  window.__twigHintsReady = true;
  var CHARS = 'asdfghjkl';
  var layer = null, targets = [], buf = '';

  function candidates() {
    var sel = 'a[href], button, input:not([type=hidden]), select, textarea,' +
      '[role=button], [role=link], [onclick], [tabindex]:not([tabindex="-1"])';
    var out = [];
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) {
      var el = els[i], r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      if (r.right < 0 || r.left > window.innerWidth) continue;
      if (el.disabled) continue;
      var st = window.getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') continue;
      out.push({ el: el, rect: r });
    }
    return out;
  }

  function labelsFor(n) {
    var len = 1, cap = CHARS.length;
    while (cap < n) { len++; cap *= CHARS.length; }
    var out = [];
    for (var i = 0; i < n; i++) {
      var s = '', x = i;
      for (var k = 0; k < len; k++) { s = CHARS.charAt(x % CHARS.length) + s; x = Math.floor(x / CHARS.length); }
      out.push(s);
    }
    return out;
  }

  function teardown() {
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    layer = null; targets = []; buf = '';
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', teardown, true);
  }

  function paint() {
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var shown = t.label.indexOf(buf) === 0;
      t.node.style.display = shown ? 'block' : 'none';
      if (!shown) continue;
      t.node.innerHTML = '';
      var hit = document.createElement('span');
      hit.textContent = t.label.slice(0, buf.length);
      hit.style.opacity = '0.45';
      var rest = document.createElement('span');
      rest.textContent = t.label.slice(buf.length);
      t.node.appendChild(hit);
      t.node.appendChild(rest);
    }
  }

  function activate(el) {
    teardown();
    try {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
      el.click();
    } catch (e) {}
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); teardown(); return; }
    if (e.key === 'Backspace') {
      e.preventDefault(); e.stopPropagation();
      buf = buf.slice(0, -1); paint(); return;
    }
    if (e.key.length !== 1 || CHARS.indexOf(e.key) === -1) return;
    e.preventDefault(); e.stopPropagation();
    buf += e.key;
    var exact = null, partial = 0;
    for (var i = 0; i < targets.length; i++) {
      if (targets[i].label === buf) exact = targets[i].el;
      if (targets[i].label.indexOf(buf) === 0) partial++;
    }
    if (exact) { activate(exact); return; }
    if (partial === 0) { teardown(); return; }
    paint();
  }

  window.__twigHints = function () {
    teardown();
    var found = candidates();
    if (!found.length) return 0;
    var labels = labelsFor(found.length);
    layer = document.createElement('div');
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    for (var i = 0; i < found.length; i++) {
      var node = document.createElement('div');
      node.textContent = labels[i];
      node.style.cssText =
        'position:fixed;top:' + Math.max(0, found[i].rect.top) + 'px;' +
        'left:' + Math.max(0, found[i].rect.left) + 'px;' +
        'transform:translate(-2px,-2px);' +
        'background:#8fbb6e;color:#12140c;font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;' +
        'padding:1px 4px;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.45);' +
        'text-transform:uppercase;letter-spacing:.04em;pointer-events:none;';
      layer.appendChild(node);
      targets.push({ el: found[i].el, label: labels[i], node: node });
    }
    document.documentElement.appendChild(layer);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', teardown, true);
    paint();
    return found.length;
  };
})();"#;

/// Reader mode. Scores blocks by how much prose they hold versus how much
/// markup, keeps the densest one, and re-renders it on a plain sheet.
/// Deliberately not a port of Readability - it's a tenth of the size and
/// gets the common case (an article inside a page full of chrome) right.
/// Toggling restores the original document.
const READER: &str = r#"(function () {
  if (window.__twigReaderReady) return;
  window.__twigReaderReady = true;
  var saved = null;

  function score(el) {
    var text = el.innerText || '';
    if (text.length < 400) return 0;
    var links = el.querySelectorAll('a');
    var linkLen = 0;
    for (var i = 0; i < links.length; i++) linkLen += (links[i].innerText || '').length;
    // Mostly-links blocks are navigation, however long they are.
    var density = linkLen / text.length;
    if (density > 0.5) return 0;
    var paras = el.querySelectorAll('p').length;
    return text.length * (1 - density) * (1 + Math.min(paras, 20) / 20);
  }

  function pick() {
    var best = null, bestScore = 0;
    var cands = document.querySelectorAll('article, main, [role=main], section, div');
    for (var i = 0; i < cands.length; i++) {
      var s = score(cands[i]);
      if (s > bestScore) { bestScore = s; best = cands[i]; }
    }
    return best;
  }

  window.__twigReader = function () {
    if (saved !== null) {
      document.body.innerHTML = saved;
      document.body.removeAttribute('data-twig-reader');
      saved = null;
      return false;
    }
    var target = pick();
    if (!target) return false;
    saved = document.body.innerHTML;
    var title = document.title || '';
    var sheet = document.createElement('div');
    sheet.setAttribute('data-twig-sheet', '');
    sheet.innerHTML = '<h1></h1>' + target.innerHTML;
    sheet.firstChild.textContent = title;
    document.body.innerHTML = '';
    document.body.setAttribute('data-twig-reader', '');
    document.body.appendChild(sheet);
    var css = document.createElement('style');
    css.textContent =
      'body[data-twig-reader]{background:#f6f4ee!important;margin:0!important;}' +
      '@media (prefers-color-scheme:dark){body[data-twig-reader]{background:#17190f!important;}' +
      'body[data-twig-reader] [data-twig-sheet]{color:#e9e7dd!important;}' +
      'body[data-twig-reader] a{color:#8fbb6e!important;}}' +
      '[data-twig-sheet]{max-width:68ch;margin:0 auto;padding:56px 24px 96px;' +
      'font:18px/1.65 -apple-system,Georgia,serif;color:#23261f;}' +
      '[data-twig-sheet] h1{font-size:2em;line-height:1.2;margin:0 0 .6em;}' +
      '[data-twig-sheet] img,[data-twig-sheet] video{max-width:100%;height:auto;border-radius:8px;}' +
      '[data-twig-sheet] pre{overflow-x:auto;padding:12px;border-radius:8px;background:rgba(127,127,127,.12);}' +
      '[data-twig-sheet] a{color:#4b6b3a;}' +
      '[data-twig-sheet] p{margin:0 0 1.15em;}';
    document.body.appendChild(css);
    window.scrollTo(0, 0);
    return true;
  };
})();"#;

/// Tab ids double as webview labels, which must be unique across the whole
/// app - not just within one window - so this is a single shared counter
/// rather than a per-window one.
static NEXT_TAB_ID: AtomicU64 = AtomicU64::new(0);

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
    pub tab_strip_visible: bool,
    pub is_private: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadDone {
    url: String,
    success: bool,
}

/// A path in `dir` named `name`, with " (2)", " (3)" and so on appended
/// until it doesn't collide. Downloading the same file twice shouldn't
/// quietly destroy the first copy.
fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = std::path::Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for n in 2..1000 {
        let next = dir.join(format!("{stem} ({n}){ext}"));
        if !next.exists() {
            return next;
        }
    }
    candidate
}

/// Shape the capture script returns: title and body text.
#[derive(Deserialize)]
struct CapturedPage {
    t: String,
    b: String,
}

/// Emitted to the chrome so it can write the page into the local
/// full-text index. The DB is reachable from the frontend, not from here.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexedPage {
    url: String,
    title: String,
    body: String,
}

/// A tab's last-known url/title/space, kept around after closing so it can
/// be reopened.
struct ClosedTab {
    url: String,
    title: String,
    group_id: String,
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
/// doesn't hibernate anything by itself - the hot-tab cap and idle sweep
/// (which only protect the *current* space's visible tabs) take care of
/// reclaiming memory from tabs left behind in other spaces over time.
struct Group {
    id: String,
    name: String,
    active_id: Option<String>,
    split_id: Option<String>,
    checkpoint_parent_id: Option<String>,
}

/// Per-window tab state. Every window (the main one, and any private ones)
/// gets its own independent `Inner`, keyed by window label - see
/// `TabManager`.
struct Inner {
    tabs: Vec<TabEntry>,
    groups: Vec<Group>,
    active_group_id: String,
    next_group_id: u64,
    tab_strip_visible: bool,
    closed_stack: Vec<ClosedTab>,
    /// Extra pixels the visible webview is pushed down by, so chrome
    /// popovers (the omnibox suggestions) have somewhere to land. Only the
    /// position moves - the size is left alone so the page doesn't
    /// re-layout, it just slides and clips at the bottom.
    content_offset: f64,
    overlay_active: bool,
    /// Private windows use a non-persistent webview data store (no cookies
    /// or site data written to disk) and skip history/bookmark recording
    /// on the frontend side.
    is_private: bool,
}

impl Default for Inner {
    fn default() -> Self {
        let first_group = Group {
            id: "1".to_string(),
            name: "Space 1".to_string(),
            active_id: None,
            split_id: None,
            checkpoint_parent_id: None,
        };
        Inner {
            tabs: Vec::new(),
            groups: vec![first_group],
            active_group_id: "1".to_string(),
            next_group_id: 1,
            tab_strip_visible: true,
            closed_stack: Vec::new(),
            content_offset: 0.0,
            overlay_active: false,
            is_private: false,
        }
    }
}

impl Inner {
    fn new_private() -> Self {
        Inner {
            is_private: true,
            ..Default::default()
        }
    }

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
            tab_strip_visible: self.tab_strip_visible,
            is_private: self.is_private,
        }
    }
}

/// Owns tab state for every window, keyed by window label. Each window (the
/// main one, and any private ones opened later) gets its own independent
/// set of tabs/spaces - see `Inner`.
/// Tab state per window, plus each tab's zoom level (kept separately since
/// it's about presentation, not tab identity).
#[derive(Default)]
pub struct TabManager(Mutex<HashMap<String, Inner>>, Mutex<HashMap<String, f64>>);

impl TabManager {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Gets (lazily creating, for windows like "main" that aren't explicitly
/// pre-registered) the tab state for `window`.
fn inner_for<'a, R: Runtime>(
    managers: &'a mut HashMap<String, Inner>,
    window: &Window<R>,
) -> &'a mut Inner {
    managers.entry(window.label().to_string()).or_insert_with(Inner::default)
}

fn tab_label(id: &str) -> String {
    format!("tab-{id}")
}

/// How much of the window's height the title bar overlays.
///
/// Child webviews are positioned against the window's *content view*,
/// which on macOS spans the full window height (`window.inner_size()`
/// reports 800pt for an 800pt window) with the title bar drawn on top of
/// its first ~32pt. The chrome webview's own CSS viewport, by contrast,
/// already starts below the title bar (`window.innerHeight` comes back
/// 768) - so this offset belongs only on the child-webview side, and the
/// chrome must not apply it again. Queried live via `contentLayoutRect`
/// rather than hardcoded, since it varies with OS version and the user's
/// accessibility text-size settings.
#[cfg(target_os = "macos")]
fn native_title_bar_height<R: Runtime>(window: &Window<R>) -> f64 {
    let Ok(ptr) = window.ns_window() else {
        return 0.0;
    };
    let Some(ns_window) =
        (unsafe { objc2::rc::Retained::retain(ptr as *mut objc2_app_kit::NSWindow) })
    else {
        return 0.0;
    };
    (ns_window.frame().size.height - ns_window.contentLayoutRect().size.height).max(0.0)
}

#[cfg(not(target_os = "macos"))]
fn native_title_bar_height<R: Runtime>(_window: &Window<R>) -> f64 {
    0.0
}

/// Where tab content starts, in window coordinates: below both the title
/// bar overlay and the chrome the webview draws beneath it.
fn top_offset<R: Runtime>(window: &Window<R>, tab_strip_visible: bool) -> f64 {
    native_title_bar_height(window) + chrome_height(tab_strip_visible)
}

/// The window area available for tab content: the full window width, minus
/// the chrome band along the top.
fn content_area<R: Runtime>(window: &Window<R>, tab_strip_visible: bool) -> tauri::Result<LogicalSize<f64>> {
    let scale = window.scale_factor()?;
    let logical = window.inner_size()?.to_logical::<f64>(scale);
    Ok(LogicalSize::new(
        logical.width.max(0.0),
        (logical.height - top_offset(window, tab_strip_visible)).max(0.0),
    ))
}

fn content_bounds<R: Runtime>(
    window: &Window<R>,
    tab_strip_visible: bool,
    content_offset: f64,
) -> tauri::Result<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let y_offset = top_offset(window, tab_strip_visible) + content_offset;
    let area = content_area(window, tab_strip_visible)?;
    Ok((LogicalPosition::new(0.0, y_offset), area))
}

/// Left/right bounds for the two panes in split view.
fn split_bounds<R: Runtime>(
    window: &Window<R>,
    tab_strip_visible: bool,
    content_offset: f64,
) -> tauri::Result<(
    (LogicalPosition<f64>, LogicalSize<f64>),
    (LogicalPosition<f64>, LogicalSize<f64>),
)> {
    let x_offset = 0.0;
    let y_offset = top_offset(window, tab_strip_visible) + content_offset;
    let area = content_area(window, tab_strip_visible)?;
    let half = ((area.width - SPLIT_GAP) / 2.0).max(0.0);
    let left = (LogicalPosition::new(x_offset, y_offset), LogicalSize::new(half, area.height));
    let right = (
        LogicalPosition::new(x_offset + half + SPLIT_GAP, y_offset),
        LogicalSize::new(half, area.height),
    );
    Ok((left, right))
}

/// Creates the webview backing a tab. If `scroll_y` is non-zero, injects a
/// script that restores that scroll offset once the page's DOM is ready
/// (used when waking a hibernated tab back up). `incognito` gives the
/// webview a non-persistent data store (no cookies/site data on disk) for
/// tabs opened in a private window.
fn spawn_webview<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    id: &str,
    url: tauri::Url,
    scroll_y: f64,
    tab_strip_visible: bool,
    content_offset: f64,
    incognito: bool,
) -> tauri::Result<Webview<R>> {
    let (position, size) = content_bounds(window, tab_strip_visible, content_offset)?;
    let label = tab_label(id);
    let app_handle = app.clone();
    let nav_id = id.to_string();
    // Matches whatever the OS reports (light/dark) so the brief placeholder
    // shown before a page's own background paints - visible on every fresh
    // webview, not just new tabs - reads as an intentional loading state
    // instead of a stray gray flash.
    let backdrop = match window.theme() {
        Ok(Theme::Dark) => Color(23, 25, 15, 255),
        _ => Color(246, 244, 238, 255),
    };
    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .incognito(incognito)
        .user_agent(USER_AGENT)
        .background_color(backdrop)
        .on_navigation(move |url| {
            // Keeps our stored URL (and the address bar) in sync with
            // real in-page navigation - link clicks, redirects, JS
            // navigation - not just navigation we ourselves triggered.
            let url = url.to_string();
            let manager = app_handle.state::<TabManager>();
            let mut managers = manager.0.lock().unwrap();
            if let Some(label) = managers
                .iter()
                .find(|(_, inner)| inner.tabs.iter().any(|t| t.id == nav_id))
                .map(|(label, _)| label.clone())
            {
                if let Some(inner) = managers.get_mut(&label) {
                    if let Some(entry) = inner.tabs.iter_mut().find(|t| t.id == nav_id) {
                        entry.url = url;
                    }
                    emit_tabs_changed(&app_handle, &label, inner);
                }
            }
            true
        });
    builder = builder.initialization_script(BUSY_TRACKER);
    builder = builder.initialization_script(LINK_HINTS);
    builder = builder.initialization_script(READER);

    // Once a page settles, lift its text out and hand it to the chrome to
    // index. Private windows are skipped: the point of them is that
    // nothing is written down.
    {
        // Downloads land in ~/Downloads under the name the server gave,
        // with a counter appended rather than overwriting anything that's
        // already there.
        let downloader = app.clone();
        builder = builder.on_download(move |_webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                let name = url
                    .path_segments()
                    .and_then(|s| s.last())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "download".to_string());
                if let Ok(dir) = downloader.path().download_dir() {
                    *destination = unique_path(&dir, &name);
                }
                let _ = downloader.emit_to(
                    EventTarget::webview(MAIN_WINDOW_LABEL),
                    "download-started",
                    destination.file_name().map(|n| n.to_string_lossy().to_string()),
                );
                true
            }
            DownloadEvent::Finished { url, success, .. } => {
                let _ = downloader.emit_to(
                    EventTarget::webview(MAIN_WINDOW_LABEL),
                    "download-finished",
                    DownloadDone { url: url.to_string(), success },
                );
                true
            }
            // The return value only gates Requested; everything else just
            // needs to satisfy the signature.
            _ => true,
        });

        let hooked = app.clone();
        let index_pages = !incognito;
        builder = builder.on_page_load(move |webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let url = payload.url().to_string();

            // Zoom is remembered per site, so a page that needs it bigger
            // stays bigger every time you come back.
            if let Some(host) = host_of(&url) {
                let level = hooked
                    .state::<TabManager>()
                    .1
                    .lock()
                    .unwrap()
                    .get(&host)
                    .copied();
                if let Some(level) = level {
                    if (level - 1.0).abs() > f64::EPSILON {
                        let _ = webview.set_zoom(level);
                    }
                }
            }

            if !index_pages {
                return;
            }
            let handle = hooked.clone();
            let _ = webview.eval_with_callback(
                "JSON.stringify({t: document.title || '', b: (document.body ? document.body.innerText : '').slice(0, 40000)})",
                move |raw| {
                    // eval hands back a JSON string literal, so it needs
                    // unwrapping once before it's an object.
                    let Ok(inner) = serde_json::from_str::<String>(&raw) else {
                        return;
                    };
                    let Ok(page) = serde_json::from_str::<CapturedPage>(&inner) else {
                        return;
                    };
                    if page.b.trim().is_empty() {
                        return;
                    }
                    let _ = handle.emit_to(
                        EventTarget::webview(MAIN_WINDOW_LABEL),
                        "page-captured",
                        IndexedPage { url: url.clone(), title: page.t, body: page.b },
                    );
                },
            );
        });
    }
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
    if inner.overlay_active {
        for id in visible_ids(inner) {
            let _ = hide_tab(app, &tab_label(&id));
        }
        return;
    }
    let group = inner.active_group();
    match &group.split_id {
        Some(split_id) => {
            let Ok((left, right)) = split_bounds(window, inner.tab_strip_visible, inner.content_offset) else {
                return;
            };
            if let Some(active) = &group.active_id {
                place(app, active, left);
            }
            place(app, split_id, right);
        }
        None => {
            let Ok(bounds) = content_bounds(window, inner.tab_strip_visible, inner.content_offset) else {
                return;
            };
            if let Some(active) = &group.active_id {
                place(app, active, bounds);
            }
        }
    }
}

fn focus_active<R: Runtime>(app: &AppHandle<R>, inner: &Inner) {
    if inner.overlay_active {
        return;
    }
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

/// Whether tearing this tab down right now would cost the user something
/// (see BUSY_TRACKER). A page that can't answer within the timeout is
/// treated as idle: one that won't run a one-line script is exactly the
/// one worth reclaiming, and its URL survives hibernation regardless.
fn is_busy<R: Runtime>(webview: &Webview<R>) -> bool {
    let (tx, rx) = mpsc::channel();
    let sent = webview.eval_with_callback(
        "(window.__twigBusy && window.__twigBusy()) || false",
        move |result| {
            let _ = tx.send(result);
        },
    );
    if sent.is_err() {
        return false;
    }
    matches!(rx.recv_timeout(Duration::from_millis(250)), Ok(v) if v.trim() == "true")
}

/// Tears down a hot tab's webview, capturing its scroll position first on a
/// best-effort basis. No-op if the tab is already hibernated.
/// Returns whether the tab was actually put to sleep. A tab that's busy
/// refuses, and callers are expected to move on to the next candidate
/// rather than insisting.
fn hibernate<R: Runtime>(app: &AppHandle<R>, entry: &mut TabEntry) -> bool {
    // An empty-url tab holds no webview in the first place, so there's
    // nothing to reclaim and nothing to show as sleeping.
    if entry.status == TabStatus::Hibernated || entry.url.is_empty() {
        return false;
    }
    let label = tab_label(&entry.id);
    if let Some(webview) = app.get_webview(&label) {
        if is_busy(&webview) {
            return false;
        }
        if let Ok(y) = capture_scroll(&webview) {
            entry.scroll_y = y;
        }
        let _ = webview.close();
    }
    entry.status = TabStatus::Hibernated;
    true
}

/// Makes sure a tab has a live webview (recreating it if it was hibernated)
/// and marks it as just-viewed. Doesn't touch position or visibility -
/// callers are expected to follow up with `sync_visible_webviews`.
fn wake<R: Runtime>(app: &AppHandle<R>, window: &Window<R>, inner: &mut Inner, id: &str) -> Result<(), String> {
    let tab_strip_visible = inner.tab_strip_visible;
    let content_offset = inner.content_offset;
    let is_private = inner.is_private;
    let entry = inner
        .tabs
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("no such tab: {id}"))?;

    // A new-tab-page tab has no webview to restore - the chrome draws it.
    if entry.status == TabStatus::Hibernated && !entry.url.is_empty() {
        let parsed: tauri::Url = entry.url.parse().map_err(|e| format!("invalid url: {e}"))?;
        spawn_webview(app, window, id, parsed, entry.scroll_y, tab_strip_visible, content_offset, is_private)
            .map_err(|e| e.to_string())?;
    }
    entry.status = TabStatus::Hot;
    entry.last_active_at = Instant::now();
    Ok(())
}

/// Hibernates hot tabs beyond `MAX_HOT_TABS`, oldest-viewed first, always
/// keeping `keep_ids` (the tab(s) currently on screen) alive.
fn enforce_hot_cap<R: Runtime>(app: &AppHandle<R>, inner: &mut Inner, keep_ids: &[String]) {
    // Tabs that declined to sleep. Without this the loop would keep
    // picking the same busy tab and never terminate.
    let mut skipped: Vec<String> = Vec::new();
    loop {
        let hot_count = inner.tabs.iter().filter(|t| t.status == TabStatus::Hot).count();
        if hot_count <= MAX_HOT_TABS {
            return;
        }
        let oldest = inner
            .tabs
            .iter()
            .filter(|t| t.status == TabStatus::Hot)
            .filter(|t| !keep_ids.iter().any(|k| k == &t.id))
            .filter(|t| !skipped.iter().any(|k| k == &t.id))
            .min_by_key(|t| t.last_active_at)
            .map(|t| t.id.clone());
        let Some(oldest_id) = oldest else {
            // Everything left is busy or pinned: going over the cap beats
            // throwing away someone's half-written form.
            return;
        };
        let slept = inner
            .tabs
            .iter_mut()
            .find(|t| t.id == oldest_id)
            .map(|entry| hibernate(app, entry))
            .unwrap_or(false);
        if !slept {
            skipped.push(oldest_id);
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

fn emit_tabs_changed<R: Runtime>(app: &AppHandle<R>, window_label: &str, inner: &Inner) {
    let _ = app.emit_to(EventTarget::webview(window_label), "tabs-changed", inner.snapshot());
    // Any change to the main window's tabs is a change worth surviving a
    // quit. Private windows are deliberately never written down.
    if window_label == MAIN_WINDOW_LABEL && !inner.is_private {
        save_session(app, inner);
    }
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
        wake(app, window, inner, &id)?;
    }

    Ok(())
}

/// Opens `url` as a new tab in the active space, making it the sole active
/// view (dropping any existing split). Shared by `create_tab` and
/// `reopen_closed_tab` - callers still need to call `sync_visible_webviews`
/// / `focus_active` / `emit_tabs_changed` themselves afterward.
fn open_tab<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    inner: &mut Inner,
    url: String,
    title: String,
) -> Result<TabInfo, String> {
    let id = (NEXT_TAB_ID.fetch_add(1, Ordering::Relaxed) + 1).to_string();
    let group_id = inner.active_group_id.clone();

    // An empty url is the new-tab page, which the chrome webview draws
    // itself - no child webview is created until you actually navigate.
    // That's why a new tab costs nothing until it holds a real page.
    if !url.is_empty() {
        let parsed = url.parse().map_err(|e| format!("invalid url: {e}"))?;
        spawn_webview(app, window, &id, parsed, 0.0, inner.tab_strip_visible, inner.content_offset, inner.is_private)
            .map_err(|e| e.to_string())?;
    }

    let (prev_active, prev_split) = {
        let group = inner.active_group();
        (group.active_id.clone(), group.split_id.clone())
    };
    if let Some(active) = prev_active {
        hide_tab(app, &tab_label(&active)).map_err(|e| e.to_string())?;
    }
    if let Some(split) = prev_split {
        hide_tab(app, &tab_label(&split)).map_err(|e| e.to_string())?;
    }

    inner.tabs.push(TabEntry {
        id: id.clone(),
        url,
        title,
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
    enforce_hot_cap(app, inner, &[id.clone()]);

    Ok(inner
        .tabs
        .iter()
        .find(|t| t.id == id)
        .map(TabEntry::to_info)
        .expect("tab was just inserted"))
}

#[tauri::command]
pub fn create_tab<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    url: Option<String>,
) -> Result<TabInfo, String> {
    let url = url.unwrap_or_default();

    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);
    let info = open_tab(&app, &window, inner, url, DEFAULT_TAB_TITLE.to_string())?;

    sync_visible_webviews(&app, &window, inner);
    focus_active(&app, inner);
    emit_tabs_changed(&app, window.label(), inner);
    Ok(info)
}

#[tauri::command]
pub fn activate_tab<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    id: String,
) -> Result<(), String> {
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);

    let group_id = inner
        .tabs
        .iter()
        .find(|t| t.id == id)
        .map(|t| t.group_id.clone())
        .ok_or_else(|| format!("no such tab: {id}"))?;

    if inner.active_group_id != group_id {
        switch_to_group(&app, &window, inner, &group_id)?;
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

        wake(&app, &window, inner, &id)?;
        {
            let group = inner.active_group_mut();
            group.active_id = Some(id.clone());
            group.split_id = None;
        }
        let keep = visible_ids(inner);
        enforce_hot_cap(&app, inner, &keep);
    }

    sync_visible_webviews(&app, &window, inner);
    focus_active(&app, inner);
    emit_tabs_changed(&app, window.label(), inner);
    Ok(())
}

#[tauri::command]
pub fn close_tab<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    id: String,
) -> Result<(), String> {
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);

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
    let closed = inner.tabs.remove(index);
    if !inner.is_private {
        inner.closed_stack.push(ClosedTab {
            url: closed.url,
            title: closed.title,
            group_id: closed.group_id,
        });
        if inner.closed_stack.len() > CLOSED_STACK_CAP {
            inner.closed_stack.remove(0);
        }
    }

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
            wake(&app, &window, inner, &promoted)?;
            inner.group_mut(&group_id).unwrap().active_id = Some(promoted);
        } else {
            let siblings = group_tab_ids(inner, &group_id);
            let next_id = siblings
                .get(group_index)
                .or_else(|| group_index.checked_sub(1).and_then(|i| siblings.get(i)))
                .cloned();
            inner.group_mut(&group_id).unwrap().active_id = next_id.clone();
            if let Some(next_id) = &next_id {
                wake(&app, &window, inner, next_id)?;
            }
        }
    }

    let keep = visible_ids(inner);
    enforce_hot_cap(&app, inner, &keep);

    sync_visible_webviews(&app, &window, inner);
    focus_active(&app, inner);
    emit_tabs_changed(&app, window.label(), inner);
    Ok(())
}

#[tauri::command]
pub fn list_tabs<R: Runtime>(window: Window<R>, manager: State<'_, TabManager>) -> TabsChangedPayload {
    let mut managers = manager.0.lock().unwrap();
    inner_for(&mut managers, &window).snapshot()
}

/// Moves the tab to `to_index` *within its own space* - `to_index` is
/// expressed in terms of that space's tab list before the move (so the
/// space's tab count means "move to the end"). Tabs from other spaces can
/// be interleaved with this one in storage order, so the move is computed
/// against the group-local subsequence rather than the raw list index.
#[tauri::command]
pub fn reorder_tab<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    id: String,
    to_index: usize,
) -> Result<(), String> {
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);

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

    emit_tabs_changed(&app, window.label(), inner);
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

/// Search URL template, with `{}` where the encoded query goes. Set from
/// Settings; Google until the frontend says otherwise.
static SEARCH_TEMPLATE: Mutex<Option<String>> = Mutex::new(None);

const DEFAULT_SEARCH_TEMPLATE: &str = "https://www.google.com/search?q={}";

/// Points the omnibox and command palette at a different search engine.
#[tauri::command]
pub fn set_search_engine(template: String) {
    *SEARCH_TEMPLATE.lock().unwrap() = Some(template);
}

/// Turns whatever was typed into the address bar or command palette into a
/// real URL: a bare host like "example.com" gets `https://` added, and
/// anything that doesn't look like a URL at all (e.g. "rust borrow checker")
/// becomes a search instead of failing to parse.
fn normalize_url(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.contains("://") {
        return trimmed.to_string();
    }
    let looks_like_url = !trimmed.contains(' ') && trimmed.contains('.');
    if looks_like_url {
        format!("https://{trimmed}")
    } else {
        let query: String = url::form_urlencoded::byte_serialize(trimmed.as_bytes()).collect();
        let template = SEARCH_TEMPLATE
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| DEFAULT_SEARCH_TEMPLATE.to_string());
        template.replace("{}", &query)
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
    window: Window<R>,
    manager: State<'_, TabManager>,
    id: String,
    url: String,
) -> Result<TabInfo, String> {
    let parsed: tauri::Url = normalize_url(&url)
        .parse()
        .map_err(|e| format!("invalid url: {e}"))?;

    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);
    let tab_strip_visible = inner.tab_strip_visible;
    let content_offset = inner.content_offset;
    let is_private = inner.is_private;
    let entry = inner
        .tabs
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("no such tab: {id}"))?;

    entry.url = parsed.to_string();
    entry.title = derive_title(&parsed);
    entry.scroll_y = 0.0;
    entry.status = TabStatus::Hot;
    entry.last_active_at = Instant::now();

    let info = entry.to_info();

    match app.get_webview(&tab_label(&id)) {
        Some(webview) => webview.navigate(parsed).map_err(|e| e.to_string())?,
        // First real navigation out of the new-tab page: this is where the
        // tab stops being free and actually gets a webview.
        None => {
            spawn_webview(&app, &window, &id, parsed, 0.0, tab_strip_visible, content_offset, is_private)
                .map_err(|e| e.to_string())?;
        }
    }

    sync_visible_webviews(&app, &window, inner);
    focus_active(&app, inner);
    emit_tabs_changed(&app, window.label(), inner);
    Ok(info)
}

/// Slides the visible webview(s) down by `offset` so a chrome popover can
/// occupy the strip it leaves behind.
///
/// This is the gentler alternative to `set_overlay_active` for anything
/// that isn't full-window: the page stays on screen instead of vanishing,
/// nothing is resized so no page re-layouts, and because focus is never
/// touched the caret stays wherever it was. The cost is that the bottom
/// `offset` pixels of the page are pushed out of view until it's cleared.
#[tauri::command]
pub fn set_content_offset<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    offset: f64,
) -> Result<(), String> {
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);
    if (inner.content_offset - offset).abs() < f64::EPSILON {
        return Ok(());
    }
    inner.content_offset = offset.max(0.0);
    sync_visible_webviews(&app, &window, inner);
    Ok(())
}

/// Hides (or restores) the current space's visible webview(s) so
/// full-window chrome overlays (the command palette, and later ones like
/// it) can actually be seen: tab content is a separate, higher native
/// webview that DOM z-index can't draw over.
#[tauri::command]
pub fn set_overlay_active<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    open: bool,
) -> Result<(), String> {
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);
    inner.overlay_active = open;
    if open {
        for id in visible_ids(inner) {
            hide_tab(&app, &tab_label(&id)).map_err(|e| e.to_string())?;
        }
        // Native menu shortcuts can arrive while a page owns keyboard
        // focus. DOM focus alone cannot move it into the chrome webview.
        if let Some(chrome) = app.get_webview(window.label()) {
            chrome.set_focus().map_err(|e| e.to_string())?;
        }
        Ok(())
    } else {
        sync_visible_webviews(&app, &window, inner);
        focus_active(&app, inner);
        Ok(())
    }
}

/// Sets (or clears, with `id: None`) the tab shown side by side with the
/// active tab. The active tab keeps its role; this only changes its
/// companion pane. The target must belong to the current space.
#[tauri::command]
pub fn set_split<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    id: Option<String>,
) -> Result<(), String> {
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);

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
        wake(&app, &window, inner, target)?;
    }
    inner.active_group_mut().split_id = id;

    let keep = visible_ids(inner);
    enforce_hot_cap(&app, inner, &keep);

    sync_visible_webviews(&app, &window, inner);
    focus_active(&app, inner);
    emit_tabs_changed(&app, window.label(), inner);
    Ok(())
}

/// Creates a new, empty space and switches to it.
#[tauri::command]
pub fn create_group<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    name: Option<String>,
) -> Result<GroupInfo, String> {
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);

    inner.next_group_id += 1;
    let id = inner.next_group_id.to_string();
    let name = name.unwrap_or_else(|| format!("Space {}", inner.groups.len() + 1));
    inner.groups.push(Group {
        id: id.clone(),
        name: name.clone(),
        active_id: None,
        split_id: None,
        checkpoint_parent_id: None,
    });

    switch_to_group(&app, &window, inner, &id)?;

    sync_visible_webviews(&app, &window, inner);
    focus_active(&app, inner);
    emit_tabs_changed(&app, window.label(), inner);
    Ok(GroupInfo { id, name })
}

/// Switches to a different space.
#[tauri::command]
pub fn switch_group<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    id: String,
) -> Result<(), String> {
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);

    switch_to_group(&app, &window, inner, &id)?;

    sync_visible_webviews(&app, &window, inner);
    focus_active(&app, inner);
    emit_tabs_changed(&app, window.label(), inner);
    Ok(())
}

/// Closes a space and every tab in it. Refuses to close the last remaining
/// space.
#[tauri::command]
pub fn close_group<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    id: String,
) -> Result<(), String> {
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);

    if !inner.groups.iter().any(|g| g.id == id) {
        return Err(format!("no such space: {id}"));
    }
    if inner.groups.len() == 1 {
        return Err("cannot close the last space".to_string());
    }

    let doomed = group_tab_ids(inner, &id);
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
            wake(&app, &window, inner, &tab_id)?;
        }
    }

    let keep = visible_ids(inner);
    enforce_hot_cap(&app, inner, &keep);

    sync_visible_webviews(&app, &window, inner);
    focus_active(&app, inner);
    emit_tabs_changed(&app, window.label(), inner);
    Ok(())
}

/// Renames a space.
#[tauri::command]
pub fn rename_group<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    id: String,
    name: String,
) -> Result<(), String> {
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);

    let name = name.trim();
    if name.is_empty() {
        return Err("space name cannot be empty".to_string());
    }
    let name = name.to_string();
    inner
        .group_mut(&id)
        .ok_or_else(|| format!("no such space: {id}"))?
        .name = name;
    emit_tabs_changed(&app, window.label(), inner);
    Ok(())
}

/// Reopens the most recently closed tab, switching to its original space
/// first (falling back to the current space if that one no longer exists).
/// Returns `None` if there's nothing to reopen.
#[tauri::command]
pub fn reopen_closed_tab<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
) -> Result<Option<TabInfo>, String> {
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);

    let Some(closed) = inner.closed_stack.pop() else {
        return Ok(None);
    };

    let group_id = if inner.groups.iter().any(|g| g.id == closed.group_id) {
        closed.group_id
    } else {
        inner.active_group_id.clone()
    };
    if inner.active_group_id != group_id {
        switch_to_group(&app, &window, inner, &group_id)?;
    }

    let info = open_tab(&app, &window, inner, closed.url, closed.title)?;

    sync_visible_webviews(&app, &window, inner);
    focus_active(&app, inner);
    emit_tabs_changed(&app, window.label(), inner);
    Ok(Some(info))
}

/// Shows or hides the tab strip, returning the new state. Hiding it gives
/// the active tab's webview that much more height - it isn't a separate
/// "collapsed" layout, just one row removed from the chrome band.
#[tauri::command]
pub fn toggle_tab_strip<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
) -> Result<bool, String> {
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);
    inner.tab_strip_visible = !inner.tab_strip_visible;
    sync_visible_webviews(&app, &window, inner);
    emit_tabs_changed(&app, window.label(), inner);
    Ok(inner.tab_strip_visible)
}

/// Finds `query` in the active tab's page via the browser's native
/// `window.find`, scrolling to and highlighting the next (or, if
/// `backwards`, previous) match. An empty query just clears the current
/// selection instead of searching.
#[tauri::command]
pub fn find_in_page<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    query: String,
    backwards: bool,
) -> Result<(), String> {
    let active_id = {
        let mut managers = manager.0.lock().unwrap();
        inner_for(&mut managers, &window).active_group().active_id.clone()
    };
    let Some(active_id) = active_id else {
        return Ok(());
    };
    let Some(webview) = app.get_webview(&tab_label(&active_id)) else {
        return Ok(());
    };

    if query.trim().is_empty() {
        let _ = webview.eval("window.getSelection() && window.getSelection().removeAllRanges();");
        return Ok(());
    }

    let query_js = serde_json::to_string(&query).map_err(|e| e.to_string())?;
    let js = format!("window.find({query_js}, false, {backwards}, true, false, false, false);");
    webview.eval(js).map_err(|e| e.to_string())
}

/// Steps back in a tab's own navigation history. A no-op if the tab is
/// hibernated (nothing to step through) or already at the start.
#[tauri::command]
pub fn go_back<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let Some(webview) = app.get_webview(&tab_label(&id)) else {
        return Ok(());
    };
    webview.eval("window.history.back();").map_err(|e| e.to_string())
}

/// Steps forward in a tab's own navigation history.
#[tauri::command]
pub fn go_forward<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let Some(webview) = app.get_webview(&tab_label(&id)) else {
        return Ok(());
    };
    webview.eval("window.history.forward();").map_err(|e| e.to_string())
}

/// Reloads a tab's current page.
#[tauri::command]
pub fn reload_tab<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let Some(webview) = app.get_webview(&tab_label(&id)) else {
        return Ok(());
    };
    webview.reload().map_err(|e| e.to_string())
}

static PRIVATE_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Opens a new private window: a completely separate window with its own
/// tabs/spaces, whose tab webviews use a non-persistent data store (no
/// cookies or site data on disk) and whose closed tabs aren't remembered
/// for reopening. The frontend is responsible for skipping history and
/// bookmark writes there (see the `isPrivate` field in `TabsChangedPayload`).
#[tauri::command]
pub fn open_private_window<R: Runtime>(app: AppHandle<R>, manager: State<'_, TabManager>) -> Result<(), String> {
    let n = PRIVATE_WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("private-{n}");

    let webview_window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("twig — Private")
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;
    let window = AsRef::<Webview<R>>::as_ref(&webview_window).window();

    manager.0.lock().unwrap().insert(label, Inner::new_private());
    watch_window(&app, &window);
    ensure_first_tab(&app, &window);

    Ok(())
}

/// The site a URL belongs to, which is the granularity zoom is remembered
/// at. www is dropped so one setting covers both spellings.
fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()?
        .host_str()
        .map(|h| h.trim_start_matches("www.").to_string())
}

fn zoom_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("zoom.json"))
}

/// Loads remembered per-site zoom. Call once at startup.
pub fn load_zoom_levels<R: Runtime>(app: &AppHandle<R>) {
    let Some(path) = zoom_path(app) else { return };
    let Ok(raw) = std::fs::read_to_string(path) else { return };
    let Ok(map) = serde_json::from_str::<HashMap<String, f64>>(&raw) else { return };
    *app.state::<TabManager>().1.lock().unwrap() = map;
}

/// Steps zoom for the site a tab is on. `direction` is 1 to zoom in, -1
/// out, 0 to reset. Stored per host rather than per tab, so it survives
/// hibernation, new tabs, and restarts alike.
#[tauri::command]
pub fn zoom_tab<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, TabManager>,
    id: String,
    direction: i32,
) -> Result<f64, String> {
    let url = manager
        .0
        .lock()
        .unwrap()
        .values()
        .find_map(|inner| inner.tabs.iter().find(|t| t.id == id).map(|t| t.url.clone()))
        .unwrap_or_default();
    let Some(host) = host_of(&url) else {
        return Ok(1.0);
    };

    let mut levels = manager.1.lock().unwrap();
    let current = *levels.get(&host).unwrap_or(&1.0);
    let next = match direction {
        0 => 1.0,
        d if d > 0 => (current + 0.1).min(3.0),
        _ => (current - 0.1).max(0.3),
    };
    let rounded = (next * 100.0).round() / 100.0;

    if let Some(webview) = app.get_webview(&tab_label(&id)) {
        webview.set_zoom(rounded).map_err(|e| e.to_string())?;
    }
    if (rounded - 1.0).abs() < f64::EPSILON {
        levels.remove(&host);
    } else {
        levels.insert(host, rounded);
    }

    if let Some(path) = zoom_path(&app) {
        if let Ok(json) = serde_json::to_string(&*levels) {
            let _ = std::fs::write(path, json);
        }
    }
    Ok(rounded)
}

/// Wipes cookies, local storage, and other site data for this window's
/// webviews - the storage that keeps you logged in to sites.
#[tauri::command]
pub fn clear_site_data<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
) -> Result<(), String> {
    let managers = manager.0.lock().unwrap();
    let Some(inner) = managers.get(window.label()) else {
        return Ok(());
    };
    for tab in &inner.tabs {
        if let Some(webview) = app.get_webview(&tab_label(&tab.id)) {
            webview.clear_all_browsing_data().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Memory accounting
//
// WKWebView renders out of process, and those WebContent processes are
// XPC services parented to launchd rather than to us - so there's no
// process tree to walk and no way to map one to a particular tab. What we
// can do honestly is record which WebContent processes already existed
// when twig started, and count anything that appears afterwards as ours.
// ---------------------------------------------------------------------

static BASELINE_WEBCONTENT: std::sync::OnceLock<std::collections::HashSet<u32>> =
    std::sync::OnceLock::new();

const WEBCONTENT: &str = "com.apple.WebKit.WebContent";

/// (pid, resident kilobytes) for every WebContent process on the machine.
fn webcontent_processes() -> Vec<(u32, u64)> {
    let Ok(out) = std::process::Command::new("ps")
        .args(["-axo", "pid=,rss=,comm="])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|line| line.contains(WEBCONTENT))
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let rss = parts.next()?.parse().ok()?;
            Some((pid, rss))
        })
        .collect()
}

/// Remembers the WebContent processes that were already running, so later
/// measurements can exclude other apps' tabs. Call once at startup, before
/// any of our own webviews exist.
pub fn snapshot_memory_baseline() {
    let _ = BASELINE_WEBCONTENT.set(webcontent_processes().into_iter().map(|(pid, _)| pid).collect());
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    /// Resident kilobytes across the WebContent processes we started.
    footprint_kb: u64,
    process_count: usize,
    awake_tabs: usize,
    sleeping_tabs: usize,
    /// What those sleeping tabs would cost at the current average, if they
    /// were all awake. An estimate, and labelled as one in the UI.
    estimated_saved_kb: u64,
}

/// Flips a tab in or out of reader mode.
#[tauri::command]
pub fn toggle_reader<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&tab_label(&id)) {
        webview
            .eval("window.__twigReader && window.__twigReader()")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Starts link-hint mode in a tab: labels everything clickable in view so
/// it can be reached by keyboard. The tab's own webview holds focus, so
/// the whole interaction runs inside the page (see LINK_HINTS) rather
/// than in the chrome.
#[tauri::command]
pub fn follow_link<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&tab_label(&id)) {
        webview
            .eval("window.__twigHints && window.__twigHints()")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Live memory accounting for the current window.
#[tauri::command]
pub fn memory_stats<R: Runtime>(
    window: Window<R>,
    manager: State<'_, TabManager>,
) -> MemoryStats {
    let baseline = BASELINE_WEBCONTENT.get();
    let mine: Vec<(u32, u64)> = webcontent_processes()
        .into_iter()
        .filter(|(pid, _)| baseline.map(|b| !b.contains(pid)).unwrap_or(true))
        .collect();
    let footprint_kb: u64 = mine.iter().map(|(_, rss)| rss).sum();

    let managers = manager.0.lock().unwrap();
    let (awake_tabs, sleeping_tabs) = managers
        .get(window.label())
        .map(|inner| {
            let awake = inner
                .tabs
                .iter()
                .filter(|t| t.status == TabStatus::Hot && !t.url.is_empty())
                .count();
            (awake, inner.tabs.len() - awake)
        })
        .unwrap_or((0, 0));

    let per_tab = if awake_tabs > 0 {
        footprint_kb / awake_tabs as u64
    } else {
        0
    };

    MemoryStats {
        footprint_kb,
        process_count: mine.len(),
        awake_tabs,
        sleeping_tabs,
        estimated_saved_kb: per_tab * sleeping_tabs as u64,
    }
}

// ---------------------------------------------------------------------
// Session persistence
//
// Restoring is cheap for the same reason hibernating is: a tab is a row,
// not a webview. Everything comes back Hibernated and only the tab you
// were last looking at gets a webview, so reopening a few hundred tabs
// costs about as much as reopening one.
// ---------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct PersistedTab {
    id: String,
    url: String,
    title: String,
    scroll_y: f64,
    group_id: String,
}

#[derive(Serialize, Deserialize)]
struct PersistedGroup {
    id: String,
    name: String,
    active_id: Option<String>,
    split_id: Option<String>,
    #[serde(default)]
    checkpoint_parent_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct PersistedSession {
    tabs: Vec<PersistedTab>,
    groups: Vec<PersistedGroup>,
    active_group_id: String,
    next_group_id: u64,
    tab_strip_visible: bool,
}

fn session_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("session.json"))
}

fn save_session<R: Runtime>(app: &AppHandle<R>, inner: &Inner) {
    let Some(path) = session_path(app) else {
        return;
    };
    let session = PersistedSession {
        tabs: inner
            .tabs
            .iter()
            .map(|t| PersistedTab {
                id: t.id.clone(),
                url: t.url.clone(),
                title: t.title.clone(),
                scroll_y: t.scroll_y,
                group_id: t.group_id.clone(),
            })
            .collect(),
        groups: inner
            .groups
            .iter()
            .map(|g| PersistedGroup {
                id: g.id.clone(),
                name: g.name.clone(),
                active_id: g.active_id.clone(),
                split_id: g.split_id.clone(),
                checkpoint_parent_id: g.checkpoint_parent_id.clone(),
            })
            .collect(),
        active_group_id: inner.active_group_id.clone(),
        next_group_id: inner.next_group_id,
        tab_strip_visible: inner.tab_strip_visible,
    };
    if let Ok(json) = serde_json::to_string(&session) {
        let _ = std::fs::write(path, json);
    }
}

/// Rebuilds last session's tabs and spaces, then wakes only the tab that
/// was active. Everything else stays a row until you touch it.
pub fn restore_session<R: Runtime>(app: &AppHandle<R>, window: &Window<R>) {
    let Some(path) = session_path(app) else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(session) = serde_json::from_str::<PersistedSession>(&raw) else {
        return;
    };
    if session.tabs.is_empty() {
        return;
    }

    // Tab ids double as webview labels app-wide, so the counter has to
    // clear everything we just restored or the next new tab collides.
    let highest = session
        .tabs
        .iter()
        .filter_map(|t| t.id.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    NEXT_TAB_ID.fetch_max(highest, Ordering::Relaxed);

    let manager = app.state::<TabManager>();
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, window);

    inner.tabs = session
        .tabs
        .into_iter()
        .map(|t| TabEntry {
            id: t.id,
            url: t.url,
            title: t.title,
            status: TabStatus::Hibernated,
            last_active_at: Instant::now(),
            scroll_y: t.scroll_y,
            group_id: t.group_id,
        })
        .collect();
    inner.groups = session
        .groups
        .into_iter()
        .map(|g| Group {
            id: g.id,
            name: g.name,
            active_id: g.active_id,
            split_id: g.split_id,
            checkpoint_parent_id: g.checkpoint_parent_id,
        })
        .collect();
    if inner.groups.is_empty() {
        inner.groups.push(Group {
            id: "1".to_string(),
            name: "Space 1".to_string(),
            active_id: None,
            split_id: None,
            checkpoint_parent_id: None,
        });
    }
    inner.active_group_id = if inner.groups.iter().any(|g| g.id == session.active_group_id) {
        session.active_group_id
    } else {
        inner.groups[0].id.clone()
    };
    inner.next_group_id = session.next_group_id.max(inner.groups.len() as u64);
    inner.tab_strip_visible = session.tab_strip_visible;

    // Split partners aren't restored: that would mean two live webviews
    // before you've asked for either.
    let active_id = {
        let group = inner.active_group_mut();
        group.split_id = None;
        group.active_id.clone()
    };

    if let Some(id) = active_id {
        if inner.tabs.iter().any(|t| t.id == id) {
            let _ = wake(app, window, inner, &id);
        }
    }
    sync_visible_webviews(app, window, inner);
    focus_active(app, inner);
    emit_tabs_changed(app, window.label(), inner);
}

/// Opens the new tab page if a window has nothing in it, so launching
/// lands somewhere usable instead of on empty chrome. Costs nothing: an
/// empty tab holds no webview until you navigate.
pub fn ensure_first_tab<R: Runtime>(app: &AppHandle<R>, window: &Window<R>) {
    let manager = app.state::<TabManager>();
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, window);
    if !inner.tabs.is_empty() {
        return;
    }
    if open_tab(app, window, inner, String::new(), DEFAULT_TAB_TITLE.to_string()).is_ok() {
        sync_visible_webviews(app, window, inner);
        focus_active(app, inner);
        emit_tabs_changed(app, window.label(), inner);
    }
}

/// Keeps a window's visible webview(s) sized to fill it whenever it
/// resizes (hidden tabs are repositioned lazily when they next become
/// visible instead), and cleans up its tab state when it closes. Call once
/// per window - at startup for the main window, and right after creating
/// each private one.
pub fn watch_window<R: Runtime>(app: &AppHandle<R>, window: &Window<R>) {
    let app_handle = app.clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) => {
            let manager = app_handle.state::<TabManager>();
            let managers = manager.0.lock().unwrap();
            let (Some(inner), Some(window)) =
                (managers.get(&label), app_handle.get_window(&label))
            else {
                return;
            };
            sync_visible_webviews(&app_handle, &window, inner);
        }
        WindowEvent::Destroyed => {
            let manager = app_handle.state::<TabManager>();
            manager.0.lock().unwrap().remove(&label);
        }
        _ => {}
    });
}

/// Background sweep that hibernates hot tabs outside each window's current
/// space once they've sat idle longer than `HIBERNATE_AFTER`. Runs for the
/// lifetime of the app, across every open window.
pub fn watch_idle_tabs<R: Runtime>(app: &AppHandle<R>) {
    let app_handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(IDLE_SWEEP_INTERVAL);

        let manager = app_handle.state::<TabManager>();
        let mut managers = manager.0.lock().unwrap();
        let now = Instant::now();

        for (label, inner) in managers.iter_mut() {
            let visible = visible_ids(inner);
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
            let mut slept_any = false;
            for id in &stale {
                if let Some(entry) = inner.tabs.iter_mut().find(|t| &t.id == id) {
                    slept_any |= hibernate(&app_handle, entry);
                }
            }
            // Busy tabs stay awake and get another look next sweep.
            if slept_any {
                emit_tabs_changed(&app_handle, label, inner);
            }
        }
    });
}
