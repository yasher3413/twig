mod tabs;

use tabs::TabManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(TabManager::new())
        .setup(|app| {
            tabs::watch_window_resize(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tabs::create_tab,
            tabs::activate_tab,
            tabs::close_tab,
            tabs::list_tabs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
