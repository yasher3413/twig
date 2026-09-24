//! The menu, as data.
//!
//! Every shortcut in twig is a native menu accelerator (see the note on
//! `build_menu` for why), and customising them means the menu has to be
//! rebuilt from a table plus the user's overrides rather than written out
//! by hand.
//!
//! Recording a new shortcut has a wrinkle: macOS hands key equivalents to
//! the menu *before* any view sees them, so pressing Cmd+T to rebind
//! something would open a tab and the recorder would never hear it.
//! `suspend_shortcuts` rebuilds the menu with accelerators stripped for
//! the duration of a recording.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, Runtime};

struct Action {
    id: &'static str,
    label: &'static str,
    menu: &'static str,
    default: &'static str,
    /// Draw a separator above this item.
    gap: bool,
}

const fn a(id: &'static str, label: &'static str, menu: &'static str, default: &'static str, gap: bool) -> Action {
    Action { id, label, menu, default, gap }
}

const ACTIONS: &[Action] = &[
    a("settings", "Settings…", "twig", "CmdOrCtrl+,", false),
    a("show-welcome", "Welcome to twig…", "twig", "", false),

    a("new-tab", "New Tab", "File", "CmdOrCtrl+T", false),
    a("new-private-window", "New Private Window", "File", "CmdOrCtrl+Shift+N", false),
    a("save-checkpoint", "Save Checkpoint…", "File", "CmdOrCtrl+Shift+S", false),
    a("package-current-space", "Package Current Space…", "File", "CmdOrCtrl+Alt+P", false),
    a("close-tab", "Close Tab", "File", "CmdOrCtrl+W", true),
    a("reopen-closed-tab", "Reopen Closed Tab", "File", "CmdOrCtrl+Shift+T", false),
    a("close-window", "Close Window", "File", "CmdOrCtrl+Shift+W", true),

    a("focus-address", "Open Location…", "Edit", "CmdOrCtrl+L", true),
    a("find-in-page", "Find in Page", "Edit", "CmdOrCtrl+F", false),
    a("follow-link", "Follow Link…", "Edit", "CmdOrCtrl+E", false),
    a("command-palette", "Command Palette…", "Edit", "CmdOrCtrl+K", false),

    a("reload", "Reload Page", "View", "CmdOrCtrl+R", false),
    a("zoom-in", "Zoom In", "View", "CmdOrCtrl+Equal", true),
    a("zoom-out", "Zoom Out", "View", "CmdOrCtrl+Minus", false),
    a("zoom-reset", "Actual Size", "View", "CmdOrCtrl+Digit0", false),
    a("toggle-reader", "Reader View", "View", "CmdOrCtrl+Shift+R", true),
    a("toggle-tab-strip", "Hide Tab Strip", "View", "CmdOrCtrl+B", false),

    a("go-back", "Back", "History", "CmdOrCtrl+BracketLeft", false),
    a("go-forward", "Forward", "History", "CmdOrCtrl+BracketRight", false),
    a("bookmark", "Bookmark This Page", "History", "CmdOrCtrl+D", true),
    a("show-bookmarks", "Show Bookmarks", "History", "CmdOrCtrl+Shift+O", false),
    a("show-history", "Show History", "History", "CmdOrCtrl+Y", true),
    a("show-recall", "Recall a Passage…", "History", "CmdOrCtrl+Shift+F", false),
    a("show-checkpoints", "Checkpoints…", "History", "CmdOrCtrl+Shift+H", false),
    a("show-research-packages", "Research Packages…", "History", "CmdOrCtrl+Shift+P", false),

    a("next-tab", "Next Tab", "Tab", "CmdOrCtrl+Shift+BracketRight", false),
    a("prev-tab", "Previous Tab", "Tab", "CmdOrCtrl+Shift+BracketLeft", false),
];

/// id -> accelerator. An empty string means deliberately unbound.
static OVERRIDES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
static SUSPENDED: AtomicBool = AtomicBool::new(false);

fn overrides_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("keybinds.json"))
}

fn current(id: &str, default: &str) -> String {
    OVERRIDES
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(id).cloned())
        .unwrap_or_else(|| default.to_string())
}

/// Assembled by hand rather than extending `Menu::default()`: that default
/// ships a Window menu whose predefined "Close Window" already claims
/// Cmd+W, and macOS routes a duplicate key equivalent to whichever item
/// comes first - so Close Tab never fired.
///
/// Shortcuts live on the menu rather than a JS `keydown` listener because
/// the active tab's webview holds keyboard focus in a separate context
/// from the chrome; macOS dispatches menu key equivalents regardless.
fn menu_item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    accel: &str,
    suspended: bool,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(id, label);
    if !suspended && !accel.is_empty() {
        b = b.accelerator(accel);
    }
    b.build(app)
}

/// Appends every action belonging to the `name` menu, in table order.
fn fill<'m, R: Runtime>(
    app: &'m AppHandle<R>,
    name: &str,
    mut builder: SubmenuBuilder<'m, R, AppHandle<R>>,
    suspended: bool,
) -> tauri::Result<SubmenuBuilder<'m, R, AppHandle<R>>> {
    for action in ACTIONS.iter().filter(|a| a.menu == name) {
        if action.gap {
            builder = builder.separator();
        }
        let accel = current(action.id, action.default);
        builder = builder.item(&menu_item(app, action.id, action.label, &accel, suspended)?);
    }
    Ok(builder)
}

pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let suspended = SUSPENDED.load(Ordering::Relaxed);

    let item = |id: &str, label: &str, accel: &str| menu_item(app, id, label, accel, suspended);
    let submenu = |name: &str, builder| fill(app, name, builder, suspended);

    let app_menu = submenu("twig", SubmenuBuilder::new(app, "twig").about(None).separator())?
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = submenu("File", SubmenuBuilder::new(app, "File"))?.build()?;

    // The predefined items are what wire up the macOS responder actions -
    // without them, copy and paste stop working in every text field.
    let edit_menu = submenu(
        "Edit",
        SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all(),
    )?
    .build()?;

    let view_menu = submenu("View", SubmenuBuilder::new(app, "View"))?.build()?;
    let history_menu = submenu("History", SubmenuBuilder::new(app, "History"))?.build()?;

    let mut tab_menu = submenu("Tab", SubmenuBuilder::new(app, "Tab"))?.separator();
    for n in 1..=9u32 {
        tab_menu = tab_menu.item(&item(
            &format!("goto-tab-{n}"),
            &format!("Go to Tab {n}"),
            &format!("CmdOrCtrl+{n}"),
        )?);
    }

    let window_menu = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &history_menu, &tab_menu.build()?, &window_menu],
    )
}

/// Reads saved overrides and applies them. Call once at startup.
pub fn load<R: Runtime>(app: &AppHandle<R>) {
    let saved = overrides_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(&raw).ok())
        .unwrap_or_default();
    *OVERRIDES.lock().unwrap() = Some(saved);
    if let Ok(menu) = build_menu(app) {
        let _ = app.set_menu(menu);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    id: &'static str,
    label: String,
    group: &'static str,
    default: &'static str,
    current: String,
}

#[tauri::command]
pub fn get_keymap() -> Vec<Binding> {
    ACTIONS
        .iter()
        .map(|a| Binding {
            id: a.id,
            label: a.label.trim_end_matches('…').to_string(),
            group: a.menu,
            default: a.default,
            current: current(a.id, a.default),
        })
        .collect()
}

/// Replaces the user's overrides wholesale. The menu is rebuilt before
/// anything is saved, so an accelerator the platform can't parse is
/// rejected with the previous keymap still in place rather than leaving
/// twig with no menu at all.
#[tauri::command]
pub fn set_keymap<R: Runtime>(app: AppHandle<R>, overrides: HashMap<String, String>) -> Result<(), String> {
    let known: std::collections::HashSet<&str> = ACTIONS.iter().map(|a| a.id).collect();
    let cleaned: HashMap<String, String> = overrides
        .into_iter()
        .filter(|(id, _)| known.contains(id.as_str()))
        .filter(|(id, accel)| ACTIONS.iter().any(|a| a.id == id && a.default != accel))
        .collect();

    let previous = OVERRIDES.lock().unwrap().replace(cleaned.clone());
    match build_menu(&app).and_then(|menu| app.set_menu(menu).map(|_| ())) {
        Ok(()) => {
            if let Some(path) = overrides_path(&app) {
                let json = serde_json::to_string(&cleaned).map_err(|e| e.to_string())?;
                std::fs::write(path, json).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        Err(e) => {
            *OVERRIDES.lock().unwrap() = previous;
            Err(format!("That shortcut can't be used: {e}"))
        }
    }
}

/// Strips (or restores) every accelerator while a shortcut is being
/// recorded, so the keys reach the recorder instead of the menu.
#[tauri::command]
pub fn suspend_shortcuts<R: Runtime>(app: AppHandle<R>, suspended: bool) -> Result<(), String> {
    SUSPENDED.store(suspended, Ordering::Relaxed);
    let menu = build_menu(&app).map_err(|e| e.to_string())?;
    app.set_menu(menu).map(|_| ()).map_err(|e| e.to_string())
}
