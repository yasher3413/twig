mod tabs;

use tabs::TabManager;
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
        .setup(|app| {
            tabs::watch_window_resize(app.handle());
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
