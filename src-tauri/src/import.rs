//! Bookmark import from Chromium-family browsers.
//!
//! Chrome, Brave, Arc, Edge and Vivaldi all keep bookmarks in the same
//! plain `Bookmarks` JSON under Application Support, readable without any
//! special permission. Safari isn't here on purpose: its bookmarks sit
//! behind Full Disk Access, and offering a row that silently fails would be
//! worse than not offering it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

const BROWSERS: &[(&str, &str, &str)] = &[
    ("chrome", "Chrome", "Google/Chrome"),
    ("arc", "Arc", "Arc/User Data"),
    ("brave", "Brave", "BraveSoftware/Brave-Browser"),
    ("edge", "Edge", "Microsoft Edge"),
    ("vivaldi", "Vivaldi", "Vivaldi"),
    ("chromium", "Chromium", "Chromium"),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    id: &'static str,
    name: &'static str,
    count: usize,
}

#[derive(Serialize)]
pub struct ImportedBookmark {
    url: String,
    title: String,
}

/// Every profile's Bookmarks file for a browser - Default plus any
/// "Profile N", since plenty of people live in a second profile.
fn bookmark_files(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name == "Default" || name.starts_with("Profile ")
        })
        .map(|e| e.path().join("Bookmarks"))
        .filter(|p| p.is_file())
        .collect()
}

fn collect(node: &Value, out: &mut Vec<ImportedBookmark>, seen: &mut HashSet<String>) {
    match node.get("type").and_then(Value::as_str) {
        Some("url") => {
            let url = node.get("url").and_then(Value::as_str).unwrap_or_default();
            // chrome://, javascript: bookmarklets and file:// don't mean
            // anything here and some are actively unsafe to open.
            if (url.starts_with("https://") || url.starts_with("http://")) && seen.insert(url.to_string()) {
                let title = node.get("name").and_then(Value::as_str).unwrap_or_default();
                out.push(ImportedBookmark { url: url.to_string(), title: title.to_string() });
            }
        }
        _ => {
            if let Some(children) = node.get("children").and_then(Value::as_array) {
                for child in children {
                    collect(child, out, seen);
                }
            }
        }
    }
}

fn read_all<R: Runtime>(app: &AppHandle<R>, id: &str) -> Vec<ImportedBookmark> {
    let Some((_, _, rel)) = BROWSERS.iter().find(|(bid, _, _)| *bid == id) else { return Vec::new() };
    let Ok(home) = app.path().home_dir() else { return Vec::new() };
    let root = home.join("Library/Application Support").join(rel);

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for file in bookmark_files(&root) {
        let Ok(raw) = std::fs::read_to_string(&file) else { continue };
        let Ok(json) = serde_json::from_str::<Value>(&raw) else { continue };
        if let Some(roots) = json.get("roots").and_then(Value::as_object) {
            for root in roots.values() {
                collect(root, &mut out, &mut seen);
            }
        }
    }
    out
}

/// Browsers on this Mac that actually have bookmarks to bring over.
#[tauri::command]
pub fn detect_browsers<R: Runtime>(app: AppHandle<R>) -> Vec<Found> {
    BROWSERS
        .iter()
        .map(|(id, name, _)| Found { id, name, count: read_all(&app, id).len() })
        .filter(|f| f.count > 0)
        .collect()
}

#[tauri::command]
pub fn read_browser_bookmarks<R: Runtime>(app: AppHandle<R>, id: String) -> Vec<ImportedBookmark> {
    read_all(&app, &id)
}
