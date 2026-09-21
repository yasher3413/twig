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
        Migration {
            version: 3,
            description: "full-text index of visited pages",
            // FTS5 ships in the bundled SQLite (libsqlite3-sys builds with
            // -DSQLITE_ENABLE_FTS5). url is UNINDEXED: it's how rows are
            // replaced, not something worth matching on - the omnibox
            // already covers URLs.
            sql: "CREATE VIRTUAL TABLE page_text USING fts5(
                url UNINDEXED,
                title,
                body,
                captured_at UNINDEXED,
                tokenize = 'porter unicode61'
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "archive of closed tabs",
            sql: "CREATE TABLE archive (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL,
                title TEXT NOT NULL,
                closed_at INTEGER NOT NULL
            );
            CREATE INDEX idx_archive_closed_at ON archive(closed_at);",
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
///
/// The menu is assembled by hand rather than extending `Menu::default()`.
/// That default ships a Window submenu whose predefined "Close Window"
/// already claims CmdOrCtrl+W, and macOS dispatches a duplicate key
/// equivalent to whichever matching item comes first - so Cmd+W closed the
/// window and our Close Tab item below it never fired. Closing a window is
/// Cmd+Shift+W here, the way browsers do it.
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    fn action<R: Runtime>(
        app: &AppHandle<R>,
        id: &str,
        label: &str,
        accel: &str,
    ) -> tauri::Result<tauri::menu::MenuItem<R>> {
        MenuItemBuilder::with_id(id, label).accelerator(accel).build(app)
    }

    let app_menu = SubmenuBuilder::new(app, "twig")
        .about(None)
        .separator()
        .item(&action(app, "settings", "Settings…", "CmdOrCtrl+,")?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&action(app, "new-tab", "New Tab", "CmdOrCtrl+T")?)
        .item(&action(app, "new-private-window", "New Private Window", "CmdOrCtrl+Shift+N")?)
        .separator()
        .item(&action(app, "close-tab", "Close Tab", "CmdOrCtrl+W")?)
        .item(&action(app, "reopen-closed-tab", "Reopen Closed Tab", "CmdOrCtrl+Shift+T")?)
        .separator()
        .item(&action(app, "close-window", "Close Window", "CmdOrCtrl+Shift+W")?)
        .build()?;

    // Without these predefined items, copy/paste stops working entirely in
    // the omnibox - they're what wire up the standard responder actions.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&action(app, "focus-address", "Open Location…", "CmdOrCtrl+L")?)
        .item(&action(app, "find-in-page", "Find in Page", "CmdOrCtrl+F")?)
        .item(&action(app, "follow-link", "Follow Link…", "CmdOrCtrl+E")?)
        .item(&action(app, "command-palette", "Command Palette…", "CmdOrCtrl+K")?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&action(app, "reload", "Reload Page", "CmdOrCtrl+R")?)
        .separator()
        .item(&action(app, "zoom-in", "Zoom In", "CmdOrCtrl+Equal")?)
        .item(&action(app, "zoom-out", "Zoom Out", "CmdOrCtrl+Minus")?)
        .item(&action(app, "zoom-reset", "Actual Size", "CmdOrCtrl+Digit0")?)
        .separator()
        .item(&action(app, "toggle-reader", "Reader View", "CmdOrCtrl+Shift+R")?)
        .item(&action(app, "toggle-tab-strip", "Hide Tab Strip", "CmdOrCtrl+B")?)
        .build()?;

    let history_menu = SubmenuBuilder::new(app, "History")
        .item(&action(app, "go-back", "Back", "CmdOrCtrl+BracketLeft")?)
        .item(&action(app, "go-forward", "Forward", "CmdOrCtrl+BracketRight")?)
        .separator()
        .item(&action(app, "bookmark", "Bookmark This Page", "CmdOrCtrl+D")?)
        .item(&action(app, "show-bookmarks", "Show Bookmarks", "CmdOrCtrl+Shift+O")?)
        .separator()
        .item(&action(app, "show-history", "Show History", "CmdOrCtrl+Y")?)
        .build()?;

    let mut tab_menu = SubmenuBuilder::new(app, "Tab")
        .item(&action(app, "next-tab", "Next Tab", "CmdOrCtrl+Shift+BracketRight")?)
        .item(&action(app, "prev-tab", "Previous Tab", "CmdOrCtrl+Shift+BracketLeft")?)
        .separator();

    for n in 1..=9u32 {
        tab_menu = tab_menu.item(&action(
            app,
            &format!("goto-tab-{n}"),
            &format!("Go to Tab {n}"),
            &format!("CmdOrCtrl+{n}"),
        )?);
    }

    let window_menu = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &history_menu,
            &tab_menu.build()?,
            &window_menu,
        ],
    )
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

            // Closing a window is a window operation, not a tab one - the
            // frontend has nothing to do with it.
            if id == "close-window" {
                let _ = window.close();
                return;
            }

            let target = EventTarget::webview(window.label());
            if let Some(n) = id.strip_prefix("goto-tab-") {
                let _ = app.emit_to(target, "menu-goto-tab", n.to_string());
            } else {
                let _ = app.emit_to(target, "menu-action", id.to_string());
            }
        })
        .setup(|app| {
            // Before any of our webviews exist, so other apps' WebContent
            // processes can be told apart from ours later.
            tabs::snapshot_memory_baseline();
            let main_window = app
                .get_window(tabs::MAIN_WINDOW_LABEL)
                .expect("main window declared in tauri.conf.json must exist");
            tabs::watch_window(app.handle(), &main_window);
            tabs::load_zoom_levels(app.handle());
            tabs::restore_session(app.handle(), &main_window);
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
            tabs::toggle_tab_strip,
            tabs::find_in_page,
            tabs::open_private_window,
            tabs::go_back,
            tabs::go_forward,
            tabs::reload_tab,
            tabs::zoom_tab,
            tabs::clear_site_data,
            tabs::set_search_engine,
            tabs::set_content_offset,
            tabs::memory_stats,
            tabs::follow_link,
            tabs::toggle_reader,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
