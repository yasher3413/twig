//! Explicitly selected research that can be read without the browser.
//! Shared files contain only the public schema below, never session state.
use super::*;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_PACKAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_LIBRARY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PACKAGES: usize = 200;
const MAX_TIMESTAMP: u64 = 8_640_000_000_000_000;
static LIBRARY_LOCK: Mutex<()> = Mutex::new(());
static NEXT_RESEARCH_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchPage {
    url: String,
    title: String,
    note: String,
    excerpts: Vec<String>,
    captured_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointSource {
    name: String,
    created_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchPackage {
    format: String,
    version: u32,
    title: String,
    description: String,
    created_at: u64,
    pages: Vec<ResearchPage>,
    // deserialize_with keeps the nullable field required in .twig files.
    #[serde(deserialize_with = "Option::deserialize")]
    source_checkpoint: Option<CheckpointSource>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedPackage {
    id: String,
    saved_at: u64,
    package: ResearchPackage,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Library {
    version: u32,
    packages: Vec<SavedPackage>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn unique_id() -> String {
    format!(
        "{:x}-{:x}-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
        NEXT_RESEARCH_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn require_public(inner: &Inner) -> Result<(), String> {
    if inner.is_private {
        Err("Research packages are unavailable in private windows".into())
    } else {
        Ok(())
    }
}

fn guard_window<R: Runtime>(window: &Window<R>, manager: &TabManager) -> Result<(), String> {
    let mut managers = manager.0.lock().map_err(|e| e.to_string())?;
    require_public(inner_for(&mut managers, window))
}

fn check_text(value: &str, label: &str, max: usize, required: bool) -> Result<(), String> {
    if (required && value.trim().is_empty()) || value.chars().count() > max {
        return Err(format!(
            "{label} must contain {}–{max} characters",
            usize::from(required)
        ));
    }
    if value
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(format!("{label} contains unsupported control characters"));
    }
    Ok(())
}

fn check_timestamp(value: u64) -> Result<(), String> {
    if value > MAX_TIMESTAMP {
        Err("Package contains an invalid date".into())
    } else {
        Ok(())
    }
}

fn normalized_url(value: &str) -> Result<String, String> {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return Err("Page address is too long or contains control characters".into());
    }
    let parsed = tauri::Url::parse(value.trim()).map_err(|_| "Invalid page address")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Packages only support HTTP(S) addresses without embedded credentials".into());
    }
    let result = parsed.to_string();
    if result.len() > 8192 {
        return Err("Normalized page address is too long".into());
    }
    Ok(result)
}

fn validate_package(mut package: ResearchPackage) -> Result<ResearchPackage, String> {
    if package.format != "twig-research" || package.version != 1 {
        return Err("Unsupported research package format or version".into());
    }
    check_text(&package.title, "Package title", 120, true)?;
    check_text(&package.description, "Description", 4000, false)?;
    check_timestamp(package.created_at)?;
    if package.pages.is_empty() || package.pages.len() > 200 {
        return Err("A research package must contain 1–200 pages".into());
    }
    for page in &mut package.pages {
        page.url = normalized_url(&page.url)?;
        check_text(&page.title, "Page title", 500, false)?;
        check_text(&page.note, "Page note", 4000, false)?;
        check_timestamp(page.captured_at)?;
        if page.excerpts.len() > 20 {
            return Err("A page can contain at most 20 excerpts".into());
        }
        for excerpt in &page.excerpts {
            check_text(excerpt, "Excerpt", 8000, false)?;
        }
    }
    if let Some(source) = &package.source_checkpoint {
        check_text(&source.name, "Checkpoint name", 120, true)?;
        check_timestamp(source.created_at)?;
    }
    if serde_json::to_vec(&package)
        .map_err(|e| e.to_string())?
        .len()
        > MAX_PACKAGE_BYTES
    {
        return Err("Research packages must be no larger than 2 MB".into());
    }
    Ok(package)
}

fn parse_package(contents: &str) -> Result<ResearchPackage, String> {
    if contents.len() > MAX_PACKAGE_BYTES {
        return Err("Research packages must be no larger than 2 MB".into());
    }
    let package = serde_json::from_str(contents)
        .map_err(|e| format!("Invalid .twig research package: {e}"))?;
    validate_package(package)
}

fn library_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("research-packages.json"))
        .map_err(|e| e.to_string())
}

fn read_library(path: &Path) -> Result<Library, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Library {
                version: 1,
                packages: Vec::new(),
            })
        }
        Err(e) => return Err(format!("Could not read research library: {e}")),
    };
    let mut bytes = Vec::new();
    file.take(MAX_LIBRARY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_LIBRARY_BYTES {
        return Err("Research library exceeds 32 MB; original file preserved".into());
    }
    let mut library: Library = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Research library is damaged; original file preserved: {e}"))?;
    if library.version != 1 || library.packages.len() > MAX_PACKAGES {
        return Err("Unsupported research library version or size; original file preserved".into());
    }
    let mut ids = HashSet::new();
    for saved in &mut library.packages {
        if saved.id.is_empty() || saved.id.len() > 128 || !ids.insert(saved.id.clone()) {
            return Err("Invalid or duplicate research package ID; original file preserved".into());
        }
        check_timestamp(saved.saved_at)?;
        saved.package = validate_package(saved.package.clone())?;
    }
    Ok(library)
}

fn private_new_file(path: &Path) -> std::io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn write_library(path: &Path, library: &Library) -> Result<(), String> {
    let bytes = serde_json::to_vec(library).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_LIBRARY_BYTES {
        return Err("Research library is full (32 MB); remove an older package first".into());
    }
    let parent = path.parent().ok_or("Invalid research library path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".research-{}.tmp", unique_id()));
    let result = (|| {
        let mut file = private_new_file(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn save_package(
    path: &Path,
    package: ResearchPackage,
    id: Option<String>,
) -> Result<SavedPackage, String> {
    let package = validate_package(package)?;
    let mut library = read_library(path)?;
    let saved = SavedPackage {
        id: id.clone().unwrap_or_else(unique_id),
        saved_at: now_ms(),
        package,
    };
    if let Some(id) = id {
        let existing = library
            .packages
            .iter_mut()
            .find(|saved| saved.id == id)
            .ok_or("Research package no longer exists")?;
        *existing = saved.clone();
    } else {
        if library.packages.len() >= MAX_PACKAGES {
            return Err(
                "Research library is full (200 packages); remove an older package first".into(),
            );
        }
        library.packages.push(saved.clone());
    }
    write_library(path, &library)?;
    Ok(saved)
}

#[tauri::command]
pub fn list_research_packages<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
) -> Result<Vec<SavedPackage>, String> {
    guard_window(&window, &manager)?;
    let _guard = LIBRARY_LOCK.lock().map_err(|e| e.to_string())?;
    let mut packages = read_library(&library_path(&app)?)?.packages;
    packages.sort_by_key(|saved| std::cmp::Reverse(saved.saved_at));
    Ok(packages)
}

#[tauri::command]
pub fn save_research_package<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    package: ResearchPackage,
    id: Option<String>,
) -> Result<SavedPackage, String> {
    guard_window(&window, &manager)?;
    let _guard = LIBRARY_LOCK.lock().map_err(|e| e.to_string())?;
    save_package(&library_path(&app)?, package, id)
}

#[tauri::command]
pub fn delete_research_package<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    id: String,
) -> Result<(), String> {
    guard_window(&window, &manager)?;
    let _guard = LIBRARY_LOCK.lock().map_err(|e| e.to_string())?;
    let path = library_path(&app)?;
    let mut library = read_library(&path)?;
    let previous_len = library.packages.len();
    library.packages.retain(|saved| saved.id != id);
    if library.packages.len() == previous_len {
        return Err("Research package no longer exists".into());
    }
    write_library(&path, &library)
}

#[tauri::command]
pub fn parse_research_package<R: Runtime>(
    window: Window<R>,
    manager: State<'_, TabManager>,
    contents: String,
) -> Result<ResearchPackage, String> {
    guard_window(&window, &manager)?;
    parse_package(&contents)
}

fn escape_html(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&#39;"),
            _ => output.push(c),
        }
    }
    output
}

fn escape_markdown(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            c if c.is_ascii_punctuation() => {
                output.push('\\');
                output.push(c);
            }
            '\r' => {}
            _ => output.push(c),
        }
    }
    output
}

fn markdown_url(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        if matches!(
            byte,
            b'<' | b'>' | b'(' | b')' | b'"' | b'\\' | b' ' | b'\t' | b'\r' | b'\n'
        ) {
            output.push_str(&format!("%{byte:02X}"));
        } else {
            output.push(byte as char);
        }
    }
    output.replace('&', "&amp;")
}

/// Gregorian civil date from Unix days; timestamps are validated before export.
fn readable_date(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64 + 719_468;
    let era = days / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let hour = (ms / 3_600_000) % 24;
    let minute = (ms / 60_000) % 60;
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02} UTC")
}

fn render_markdown(package: &ResearchPackage) -> String {
    let mut output = format!(
        "# {}\n\nCreated {}\n\n",
        escape_markdown(&package.title),
        readable_date(package.created_at)
    );
    if !package.description.is_empty() {
        output.push_str(&format!("{}\n\n", escape_markdown(&package.description)));
    }
    if let Some(source) = &package.source_checkpoint {
        output.push_str(&format!(
            "From checkpoint: {} — {}\n\n",
            escape_markdown(&source.name),
            readable_date(source.created_at)
        ));
    }
    for (index, page) in package.pages.iter().enumerate() {
        let title = if page.title.is_empty() {
            &page.url
        } else {
            &page.title
        };
        output.push_str(&format!(
            "## {}. {}\n\n[Source](<{}>) · Captured {}\n\n",
            index + 1,
            escape_markdown(title),
            markdown_url(&page.url),
            readable_date(page.captured_at)
        ));
        if !page.note.is_empty() {
            output.push_str(&format!("{}\n\n", escape_markdown(&page.note)));
        }
        for excerpt in &page.excerpts {
            for line in escape_markdown(excerpt).split('\n') {
                output.push_str(&format!("> {line}\n"));
            }
            output.push('\n');
        }
    }
    output
}

fn render_html(package: &ResearchPackage) -> String {
    let mut output = format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>{}</title><style>
:root{{color-scheme:light}}*{{box-sizing:border-box}}body{{margin:0;background:#f7f4ec;color:#282c20;font:17px/1.75 system-ui,-apple-system,sans-serif}}main{{max-width:800px;padding:72px 28px;margin:auto}}header{{border-bottom:1px solid #d9d8ca;padding-bottom:32px;margin-bottom:44px}}h1,h2{{font-family:Georgia,serif;line-height:1.2;font-weight:500;overflow-wrap:anywhere}}h1{{font-size:clamp(34px,6vw,56px);margin:12px 0 24px}}h2{{font-size:28px;margin:0 0 12px}}article{{margin:0 0 52px}}a{{color:#49633a;text-underline-offset:4px;overflow-wrap:anywhere}}.meta{{font-size:13px;color:#636959}}.text,blockquote{{white-space:pre-wrap;overflow-wrap:anywhere}}blockquote{{margin:24px 0;padding:12px 24px;border-left:3px solid #9eae83;background:#efeee4}}@media print{{body{{background:white}}main{{padding:0}}article{{break-inside:avoid}}}}
</style></head><body><main><header><h1>{}</h1><p class="meta">Created {}</p>"#,
        escape_html(&package.title),
        escape_html(&package.title),
        readable_date(package.created_at)
    );
    if !package.description.is_empty() {
        output.push_str(&format!(
            "<p class=\"text\">{}</p>",
            escape_html(&package.description)
        ));
    }
    if let Some(source) = &package.source_checkpoint {
        output.push_str(&format!(
            "<p class=\"meta\">From checkpoint: {} · {}</p>",
            escape_html(&source.name),
            readable_date(source.created_at)
        ));
    }
    output.push_str("</header>");
    for (index, page) in package.pages.iter().enumerate() {
        let title = if page.title.is_empty() {
            &page.url
        } else {
            &page.title
        };
        output.push_str(&format!("<article><h2>{}. {}</h2><p class=\"meta\"><a href=\"{}\" rel=\"noreferrer noopener\">{}</a><br>Captured {}</p>", index + 1, escape_html(title), escape_html(&page.url), escape_html(&page.url), readable_date(page.captured_at)));
        if !page.note.is_empty() {
            output.push_str(&format!(
                "<p class=\"text\">{}</p>",
                escape_html(&page.note)
            ));
        }
        for excerpt in &page.excerpts {
            output.push_str(&format!(
                "<blockquote>{}</blockquote>",
                escape_html(excerpt)
            ));
        }
        output.push_str("</article>");
    }
    output.push_str("</main></body></html>\n");
    output
}

fn export_contents(
    package: ResearchPackage,
    format: &str,
) -> Result<(ResearchPackage, &'static str, String), String> {
    let package = validate_package(package)?;
    let (extension, contents) = match format {
        "twig" => (
            "twig",
            serde_json::to_string(&package).map_err(|e| e.to_string())?,
        ),
        "markdown" => ("md", render_markdown(&package)),
        "html" => ("html", render_html(&package)),
        _ => return Err("Choose twig, markdown, or html export format".into()),
    };
    Ok((package, extension, contents))
}

fn filename_stem(title: &str) -> String {
    let mut stem = String::new();
    for c in title.chars() {
        if stem.len() >= 72 {
            break;
        }
        if c.is_ascii_alphanumeric() {
            stem.push(c.to_ascii_lowercase());
        } else if !stem.is_empty() && !stem.ends_with('-') {
            stem.push('-');
        }
    }
    let stem = stem.trim_matches('-');
    if stem.is_empty() {
        "research-package".into()
    } else {
        format!("research-{stem}")
    }
}

fn write_export(
    dir: &Path,
    title: &str,
    extension: &str,
    contents: &str,
) -> Result<PathBuf, String> {
    if !matches!(extension, "twig" | "md" | "html") {
        return Err("Invalid export extension".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stem = filename_stem(title);
    for counter in 1..=10_000 {
        let suffix = if counter == 1 {
            String::new()
        } else {
            format!("-{counter}")
        };
        let path = dir.join(format!("{stem}{suffix}.{extension}"));
        let mut file = match private_new_file(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not create export: {e}")),
        };
        if let Err(error) = file
            .write_all(contents.as_bytes())
            .and_then(|()| file.sync_all())
        {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(format!("Could not finish export: {error}"));
        }
        return Ok(path);
    }
    Err("Too many exports with this name; choose a different package title".into())
}

#[tauri::command]
pub fn export_research_package<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    package: ResearchPackage,
    format: String,
) -> Result<String, String> {
    guard_window(&window, &manager)?;
    let (package, extension, contents) = export_contents(package, &format)?;
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    write_export(&dir, &package.title, extension, &contents)
        .map(|path| path.to_string_lossy().into_owned())
}

fn append_package(inner: &mut Inner, package: &ResearchPackage) -> Result<String, String> {
    require_public(inner)?;
    let package = validate_package(package.clone())?;
    inner.next_group_id = inner
        .next_group_id
        .checked_add(1)
        .ok_or("Space ID limit reached")?;
    let group_id = inner.next_group_id.to_string();
    let mut active_id = None;
    for page in &package.pages {
        let id = (NEXT_TAB_ID.fetch_add(1, Ordering::Relaxed) + 1).to_string();
        if active_id.is_none() {
            active_id = Some(id.clone());
        }
        inner.tabs.push(TabEntry {
            id,
            url: page.url.clone(),
            title: page.title.clone(),
            status: TabStatus::Hibernated,
            last_active_at: Instant::now(),
            last_used_ms: super::wall_ms(),
            scroll_y: 0.0,
            group_id: group_id.clone(),
        });
    }
    inner.groups.push(Group {
        id: group_id.clone(),
        name: package.title,
        active_id,
        split_id: None,
        checkpoint_parent_id: None,
    });
    Ok(group_id)
}

#[tauri::command]
pub fn open_research_package<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    package: ResearchPackage,
) -> Result<(), String> {
    let mut managers = manager.0.lock().map_err(|e| e.to_string())?;
    let inner = inner_for(&mut managers, &window);
    require_public(inner)?;
    let previous_group = inner.active_group_id.clone();
    let group_id = append_package(inner, &package)?;
    // Preserve every existing webview, including unsaved forms. The first
    // imported page is the only one that needs a new live webview.
    if let Err(error) = switch_to_group(&app, &window, inner, &group_id) {
        for tab in inner.tabs.iter().filter(|tab| tab.group_id == group_id) {
            if let Some(webview) = app.get_webview(&tab_label(&tab.id)) {
                let _ = webview.close();
            }
        }
        inner.tabs.retain(|tab| tab.group_id != group_id);
        inner.groups.retain(|group| group.id != group_id);
        inner.active_group_id = previous_group;
        sync_visible_webviews(&app, &window, inner);
        focus_active(&app, inner);
        return Err(error);
    }
    sync_visible_webviews(&app, &window, inner);
    focus_active(&app, inner);
    emit_tabs_changed(&app, window.label(), inner);
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectedExcerpt {
    url: String,
    text: String,
}

// Only the user's selection is read. Reject selections that touch editable
// controls, including selections spanning from body text into an editor.
const CAPTURE_SELECTION: &str = r#"JSON.stringify((function(){
  var selection=window.getSelection();
  if(!selection || selection.isCollapsed || !selection.rangeCount) return null;
  var selector='input,textarea,select,[contenteditable]:not([contenteditable="false"])';
  if(document.activeElement && document.activeElement.closest(selector)) return null;
  var controls=document.querySelectorAll(selector);
  for(var r=0;r<selection.rangeCount;r++){
    var range=selection.getRangeAt(r);
    for(var i=0;i<controls.length;i++) if(range.intersectsNode(controls[i])) return null;
  }
  var text=selection.toString().trim().slice(0,8000);
  if(text.length && /[\uD800-\uDBFF]/.test(text.charAt(text.length-1))) text=text.slice(0,-1);
  return text ? {url:location.href,text:text} : null;
})())"#;

fn parse_selection(raw: &str) -> Result<Option<SelectedExcerpt>, String> {
    if raw.len() > 256 * 1024 {
        return Err("Selected excerpt response is too large".into());
    }
    let json: String = serde_json::from_str(raw).map_err(|_| "Could not read selected text")?;
    let selection: Option<SelectedExcerpt> =
        serde_json::from_str(&json).map_err(|_| "Could not read selected text")?;
    selection
        .map(|mut selected| {
            selected.url = normalized_url(&selected.url)?;
            check_text(&selected.text, "Selected excerpt", 8000, true)?;
            Ok(selected)
        })
        .transpose()
}

#[tauri::command]
pub async fn capture_research_excerpt<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
) -> Result<Option<SelectedExcerpt>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<TabManager>();
        let active_id = {
            let mut managers = manager.0.lock().map_err(|e| e.to_string())?;
            let inner = inner_for(&mut managers, &window);
            require_public(inner)?;
            inner.active_group().active_id.clone()
        };
        let Some(webview) = active_id.and_then(|id| app.get_webview(&tab_label(&id))) else {
            return Ok(None);
        };
        let (tx, rx) = mpsc::channel();
        webview
            .eval_with_callback(CAPTURE_SELECTION, move |raw| {
                let _ = tx.send(raw);
            })
            .map_err(|e| e.to_string())?;
        let raw = rx
            .recv_timeout(Duration::from_millis(800))
            .map_err(|_| "The page did not respond; select the passage and try again")?;
        parse_selection(&raw)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> ResearchPackage {
        ResearchPackage {
            format: "twig-research".into(),
            version: 1,
            title: "Database research".into(),
            description: "Compare tradeoffs".into(),
            created_at: 1_709_251_200_000,
            pages: vec![
                ResearchPage {
                    url: "https://example.com/sqlite".into(),
                    title: "SQLite".into(),
                    note: "Keep it simple".into(),
                    excerpts: vec![
                        "First passage\nSecond line".into(),
                        "Another passage".into(),
                    ],
                    captured_at: 1_709_164_800_000,
                },
                ResearchPage {
                    url: "https://example.com/postgres".into(),
                    title: "Postgres".into(),
                    note: String::new(),
                    excerpts: Vec::new(),
                    captured_at: 0,
                },
            ],
            source_checkpoint: Some(CheckpointSource {
                name: "Before comparison".into(),
                created_at: 0,
            }),
        }
    }

    fn temporary_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("twig-research-test-{}", unique_id()));
        fs::create_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn package_roundtrip_preserves_order_annotations_and_provenance() {
        let package = fixture();
        let (_, _, json) = export_contents(package.clone(), "twig").unwrap();
        assert_eq!(parse_package(&json).unwrap(), package);
        assert!(!json.contains("savedAt"));
        assert!(!json.contains("parentId"));
        let mut without_source = package.clone();
        without_source.source_checkpoint = None;
        assert_eq!(
            parse_package(&serde_json::to_string(&without_source).unwrap()).unwrap(),
            without_source
        );
    }

    #[test]
    fn rejects_malformed_future_unknown_and_oversized_packages() {
        assert!(parse_package("{broken").is_err());
        let mut value = serde_json::to_value(fixture()).unwrap();
        value["version"] = 2.into();
        assert!(parse_package(&value.to_string()).is_err());
        value["version"] = 1.into();
        value["cookies"] = "private".into();
        assert!(parse_package(&value.to_string()).is_err());
        value.as_object_mut().unwrap().remove("cookies");
        value["pages"][0]["password"] = "secret".into();
        assert!(parse_package(&value.to_string()).is_err());
        assert!(parse_package(&" ".repeat(MAX_PACKAGE_BYTES + 1)).is_err());
        let mut package = fixture();
        package.pages[0].excerpts = vec!["x".repeat(8001)];
        assert!(validate_package(package).is_err());
        let mut package = fixture();
        package.pages = vec![package.pages[0].clone(); 201];
        assert!(validate_package(package).is_err());
        let mut package = fixture();
        package.created_at = MAX_TIMESTAMP + 1;
        assert!(validate_package(package).is_err());
        let mut package = fixture();
        package.pages[0].excerpts = vec!["x".repeat(8000); 20];
        package.pages = vec![package.pages[0].clone(); 20];
        assert!(validate_package(package).is_err());
    }

    #[test]
    fn rejects_unsafe_urls_and_normalizes_public_addresses() {
        for url in [
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///etc/passwd",
            "https://user:secret@example.com",
            "https://user@example.com",
            "https://example.com\n.evil.test",
            "https://",
        ] {
            let mut package = fixture();
            package.pages[0].url = url.into();
            assert!(validate_package(package).is_err(), "accepted {url}");
        }
        assert_eq!(
            normalized_url("HTTPS://EXAMPLE.COM:443").unwrap(),
            "https://example.com/"
        );
    }

    #[test]
    fn html_and_markdown_keep_hostile_content_inert() {
        let mut package = fixture();
        let hostile = "</style><script>alert('x')</script>\n# Heading\n![x](javascript:alert(1)) & <img src=x onerror=alert(1)>";
        package.description = hostile.into();
        package.pages[0].title = hostile.into();
        package.pages[0].note = hostile.into();
        package.pages[0].excerpts = vec![hostile.into()];
        package.source_checkpoint.as_mut().unwrap().name = "<svg/onload=alert(1)>".into();
        package.pages[0].url = "https://example.com/\"?q=<x>&b=2".into();
        let (_, _, html) = export_contents(package.clone(), "html").unwrap();
        assert!(!html.contains("<script>"));
        assert!(!html.contains("<img"));
        assert!(!html.contains("<svg"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("default-src 'none'"));
        assert!(html.contains("<blockquote>"));
        assert!(html.contains("2024-02-29"));
        let (_, _, markdown) = export_contents(package, "markdown").unwrap();
        assert!(!markdown.contains("<script>"));
        assert!(!markdown.contains("![x]"));
        assert!(!markdown.contains("\n# Heading"));
        assert!(markdown.contains("&lt;script&gt;"));
        assert!(markdown.contains("\\!\\[x\\]"));
        assert!(markdown.contains("[Source](<https://example.com/"));
        assert!(markdown.contains("From checkpoint:"));
    }

    #[test]
    fn readable_dates_cover_epoch_and_leap_day() {
        assert_eq!(readable_date(0), "1970-01-01 00:00 UTC");
        assert_eq!(readable_date(1_709_164_800_000), "2024-02-29 00:00 UTC");
        assert_eq!(readable_date(MAX_TIMESTAMP), "275760-09-13 00:00 UTC");
    }

    #[test]
    fn exports_use_safe_unique_paths_and_never_overwrite() {
        let dir = temporary_dir();
        let first = write_export(&dir, "../../CON\\secret", "twig", "first").unwrap();
        let second = write_export(&dir, "../../CON\\secret", "twig", "second").unwrap();
        assert_eq!(first.parent(), Some(dir.as_path()));
        assert_eq!(second.parent(), Some(dir.as_path()));
        assert_ne!(first, second);
        assert_eq!(fs::read_to_string(&first).unwrap(), "first");
        assert_eq!(fs::read_to_string(&second).unwrap(), "second");
        assert_eq!(filename_stem("..."), "research-package");
        assert!(write_export(&dir, "ok", "../../bad", "bad").is_err());
        fs::remove_file(first).unwrap();
        fs::remove_file(second).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn library_roundtrip_replacement_and_corruption_preservation() {
        let dir = temporary_dir();
        let path = dir.join("library.json");
        assert!(read_library(&path).unwrap().packages.is_empty());
        let saved = save_package(&path, fixture(), None).unwrap();
        let mut changed = saved.package.clone();
        changed.pages.reverse();
        changed.pages[0].note = "Updated".into();
        let updated = save_package(&path, changed, Some(saved.id.clone())).unwrap();
        assert_eq!(updated.id, saved.id);
        assert_eq!(read_library(&path).unwrap().packages, [updated]);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::write(&path, b"{damaged").unwrap();
        assert!(save_package(&path, fixture(), None).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{damaged");
        fs::remove_file(path).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn opening_preserves_originals_creates_ordered_sleeping_tabs_without_lineage() {
        let mut inner = Inner::default();
        inner.tabs.push(TabEntry {
            id: "original".into(),
            url: "https://original.test/".into(),
            title: "Original".into(),
            status: TabStatus::Hot,
            last_active_at: Instant::now(),
            last_used_ms: 0,
            scroll_y: 42.0,
            group_id: "1".into(),
        });
        inner.active_group_mut().active_id = Some("original".into());
        let group_id = append_package(&mut inner, &fixture()).unwrap();
        assert_eq!(inner.active_group_id, "1");
        assert_eq!(inner.tabs[0].id, "original");
        assert_eq!(inner.tabs[0].status, TabStatus::Hot);
        assert_eq!(inner.tabs[0].scroll_y, 42.0);
        let group = inner.group(&group_id).unwrap();
        assert!(group.checkpoint_parent_id.is_none());
        assert!(group.split_id.is_none());
        assert_eq!(group.active_id.as_ref(), Some(&inner.tabs[1].id));
        assert_eq!(inner.tabs[1].url, "https://example.com/sqlite");
        assert_eq!(inner.tabs[2].url, "https://example.com/postgres");
        assert!(inner.tabs[1..]
            .iter()
            .all(|tab| tab.status == TabStatus::Hibernated));
        let mut private = Inner::new_private();
        assert!(require_public(&private).is_err());
        assert!(append_package(&mut private, &fixture()).is_err());
        assert!(private.tabs.is_empty());
    }

    #[test]
    fn selected_excerpt_is_bounded_and_public() {
        let raw =
            serde_json::to_string(r#"{"url":"https://example.com","text":"selected passage"}"#)
                .unwrap();
        let selected = parse_selection(&raw).unwrap().unwrap();
        assert_eq!(selected.url, "https://example.com/");
        assert_eq!(selected.text, "selected passage");
        assert!(parse_selection("\"null\"").unwrap().is_none());
        let raw = serde_json::to_string(&format!(
            r#"{{"url":"https://example.com","text":"{}"}}"#,
            "x".repeat(8001)
        ))
        .unwrap();
        assert!(parse_selection(&raw).is_err());
        assert!(CAPTURE_SELECTION.contains("range.intersectsNode"));
        assert!(CAPTURE_SELECTION.contains("selection.toString()"));
        assert!(!CAPTURE_SELECTION.contains("innerText"));
    }
}
