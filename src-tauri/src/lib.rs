mod import;
mod keymap;
mod tabs;

use tabs::TabManager;
use tauri::{Emitter, EventTarget, Manager};
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
        Migration {
            version: 5,
            description: "recall captures",
            sql: include_str!("../migrations/005_recall.sql"),
            kind: MigrationKind::Up,
        },
    ]
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
        .menu(keymap::build_menu)
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
            keymap::load(app.handle());
            tabs::restore_session(app.handle(), &main_window);
            tabs::ensure_first_tab(app.handle(), &main_window);
            tabs::watch_idle_tabs(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tabs::create_tab,
            tabs::recall::open_recalled_page,
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
            tabs::set_hot_cap,
            keymap::get_keymap,
            keymap::set_keymap,
            keymap::suspend_shortcuts,
            import::detect_browsers,
            import::read_browser_bookmarks,
            tabs::memory_stats,
            tabs::follow_link,
            tabs::toggle_reader,
            tabs::checkpoints::list_checkpoints,
            tabs::checkpoints::save_checkpoint,
            tabs::checkpoints::restore_checkpoint,
            tabs::checkpoints::delete_checkpoint,
            tabs::research::list_research_packages,
            tabs::research::save_research_package,
            tabs::research::delete_research_package,
            tabs::research::parse_research_package,
            tabs::research::export_research_package,
            tabs::research::open_research_package,
            tabs::research::capture_research_excerpt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
