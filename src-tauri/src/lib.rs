mod tabs;

use tabs::TabManager;
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime};
use tauri_plugin_sql::{Migration, MigrationKind};

/// The frontend talks to this database directly via @tauri-apps/plugin-sql
/// (see src/lib/db.ts) - there's no Rust-side history/bookmarks code,
/// since the plugin's query methods aren't exposed outside its own crate.
const DB_URL: &str = "sqlite:twig.db";

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create history table",
            sql: "CREATE TABLE history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL,
                title TEXT NOT NULL,
                visited_at INTEGER NOT NULL
            );
            CREATE INDEX idx_history_url ON history(url);",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create bookmarks table",
            sql: "CREATE TABLE bookmarks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );",
            kind: MigrationKind::Up,
        },
    ]
}

/// Keyboard shortcuts live on a native menu rather than a JS `keydown`
/// listener in the chrome webview: the active tab's webview normally holds
/// keyboard focus (see tabs::focus_active), which is a completely separate
/// webview/JS context from our React chrome, so a page-level shortcut
/// listener there would silently never fire once you've looked at a page.
/// macOS dispatches menu key equivalents at the OS level before delivering
/// to whichever view has focus, so this works regardless.
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;

    let mut tab_menu = SubmenuBuilder::new(app, "Tab")
        .item(&MenuItemBuilder::with_id("new-tab", "New Tab").accelerator("CmdOrCtrl+T").build(app)?)
        .item(&MenuItemBuilder::with_id("close-tab", "Close Tab").accelerator("CmdOrCtrl+W").build(app)?)
        .item(
            &MenuItemBuilder::with_id("reopen-closed-tab", "Reopen Closed Tab")
                .accelerator("CmdOrCtrl+Shift+T")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("new-private-window", "New Private Window")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("command-palette", "Command Palette…")
                .accelerator("CmdOrCtrl+K")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("find-in-page", "Find in Page").accelerator("CmdOrCtrl+F").build(app)?)
        .item(&MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar").accelerator("CmdOrCtrl+B").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("settings", "Settings…").accelerator("CmdOrCtrl+,").build(app)?)
        .separator();

    for n in 1..=9u32 {
        tab_menu = tab_menu.item(
            &MenuItemBuilder::with_id(format!("goto-tab-{n}"), format!("Go to Tab {n}"))
                .accelerator(format!("CmdOrCtrl+{n}"))
                .build(app)?,
        );
    }

    menu.append(&tab_menu.build()?)?;
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DB_URL, migrations())
                .build(),
        )
        .manage(TabManager::new())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();

            // Not tied to any particular window's tab state - handled here
            // directly rather than forwarded to a frontend.
            if id == "new-private-window" {
                let _ = tabs::open_private_window(app.clone(), app.state());
                return;
            }

            // Every other action targets whichever window was focused when
            // the accelerator fired - a plain broadcast would make every
            // open window (main plus any private ones) act on it at once.
            let Some(window) = app.get_focused_window() else {
                return;
            };
            let target = EventTarget::webview(window.label());
            if let Some(n) = id.strip_prefix("goto-tab-") {
                let _ = app.emit_to(target, "menu-goto-tab", n.to_string());
            } else {
                let _ = app.emit_to(target, "menu-action", id.to_string());
            }
        })
        .setup(|app| {
            let main_window = app
                .get_window(tabs::MAIN_WINDOW_LABEL)
                .expect("main window declared in tauri.conf.json must exist");
            tabs::watch_window(app.handle(), &main_window);
            tabs::watch_idle_tabs(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tabs::create_tab,
            tabs::activate_tab,
            tabs::close_tab,
            tabs::list_tabs,
            tabs::reorder_tab,
            tabs::navigate_tab,
            tabs::set_overlay_active,
            tabs::set_split,
            tabs::create_group,
            tabs::switch_group,
            tabs::close_group,
            tabs::rename_group,
            tabs::reopen_closed_tab,
            tabs::toggle_sidebar,
            tabs::find_in_page,
            tabs::open_private_window,
            tabs::go_back,
            tabs::go_forward,
            tabs::reload_tab,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
