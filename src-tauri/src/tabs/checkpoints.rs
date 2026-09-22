//! Immutable, explicit snapshots of a space. Cookies and page/form contents
//! never enter this store; restoring always creates a separate space.
use super::*;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_CHECKPOINTS: usize = 1000;
const MAX_TABS: usize = 1000;
const MAX_STORE_BYTES: u64 = 32 * 1024 * 1024;
static STORE_LOCK: Mutex<()> = Mutex::new(());
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointTab {
    id: String,
    url: String,
    title: String,
    scroll_y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    id: String,
    name: String,
    note: String,
    created_at: u64,
    space_name: String,
    parent_id: Option<String>,
    tabs: Vec<CheckpointTab>,
    active_id: Option<String>,
    split_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Store {
    version: u32,
    checkpoints: Vec<Checkpoint>,
}

fn unique_id() -> String {
    format!(
        "{:x}-{:x}-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn require_public(inner: &Inner) -> Result<(), String> {
    if inner.is_private {
        Err("Checkpoints are unavailable in private windows".into())
    } else {
        Ok(())
    }
}

fn bounded_text(value: &str, label: &str, max: usize, required: bool) -> Result<String, String> {
    let value = value.trim();
    if (required && value.is_empty()) || value.chars().count() > max {
        return Err(format!(
            "{label} must contain {}–{max} characters",
            usize::from(required)
        ));
    }
    Ok(value.to_string())
}

fn validate(checkpoint: &Checkpoint) -> Result<(), String> {
    bounded_text(&checkpoint.name, "Checkpoint name", 120, true)?;
    bounded_text(&checkpoint.note, "Note", 2000, false)?;
    if checkpoint.id.is_empty() || checkpoint.tabs.is_empty() || checkpoint.tabs.len() > MAX_TABS {
        return Err("Invalid checkpoint identity or tab count".into());
    }
    let mut ids = HashSet::new();
    for tab in &checkpoint.tabs {
        if tab.id.is_empty()
            || !ids.insert(&tab.id)
            || !tab.scroll_y.is_finite()
            || tab.scroll_y < 0.0
        {
            return Err("Invalid checkpoint tab identity or scroll position".into());
        }
        if tab.url.len() > 32_768 || tab.title.len() > 16_384 {
            return Err("Checkpoint page address or title is too long".into());
        }
        if !tab.url.is_empty() {
            let url = tauri::Url::parse(&tab.url).map_err(|_| "Invalid checkpoint page address")?;
            if !matches!(url.scheme(), "http" | "https" | "file" | "about") {
                return Err("Unsupported checkpoint page address".into());
            }
        }
    }
    if checkpoint
        .active_id
        .as_ref()
        .is_none_or(|id| !ids.contains(id))
        || checkpoint
            .split_id
            .as_ref()
            .is_some_and(|id| !ids.contains(id))
        || (checkpoint.split_id.is_some() && checkpoint.split_id == checkpoint.active_id)
    {
        return Err("Invalid checkpoint active or split tab".into());
    }
    Ok(())
}

fn store_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("checkpoints.json"))
        .map_err(|e| e.to_string())
}

fn read_store(path: &Path) -> Result<Store, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Store {
                version: 1,
                checkpoints: Vec::new(),
            });
        }
        Err(e) => return Err(format!("Could not read checkpoints: {e}")),
    };
    if metadata.len() > MAX_STORE_BYTES {
        return Err("Checkpoint store exceeds the 32 MB limit".into());
    }
    let data = fs::read(path).map_err(|e| format!("Could not read checkpoints: {e}"))?;
    let store: Store = serde_json::from_slice(&data).map_err(|e| {
        format!("Checkpoint store is damaged; the original file has been preserved: {e}")
    })?;
    if store.version != 1 || store.checkpoints.len() > MAX_CHECKPOINTS {
        return Err("Unsupported checkpoint store version or size; original file preserved".into());
    }
    let mut ids = HashSet::new();
    for checkpoint in &store.checkpoints {
        validate(checkpoint)?;
        if !ids.insert(&checkpoint.id) {
            return Err("Checkpoint store contains duplicate IDs; original file preserved".into());
        }
    }
    Ok(store)
}

fn write_store(path: &Path, store: &Store) -> Result<(), String> {
    let bytes = serde_json::to_vec(store).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_STORE_BYTES {
        return Err("Checkpoint store is full (32 MB); delete an older checkpoint first".into());
    }
    let parent = path.parent().ok_or("Invalid checkpoint store path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".checkpoints-{}.tmp", unique_id()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
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

fn snapshot(inner: &Inner, name: String, note: String) -> Result<Checkpoint, String> {
    require_public(inner)?;
    let group = inner.active_group();
    let checkpoint = Checkpoint {
        id: unique_id(),
        name: bounded_text(&name, "Checkpoint name", 120, true)?,
        note: bounded_text(&note, "Note", 2000, false)?,
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        space_name: group.name.clone(),
        parent_id: group.checkpoint_parent_id.clone(),
        tabs: inner
            .tabs
            .iter()
            .filter(|tab| tab.group_id == group.id)
            .map(|tab| CheckpointTab {
                id: tab.id.clone(),
                url: tab.url.clone(),
                title: tab.title.clone(),
                scroll_y: tab.scroll_y,
            })
            .collect(),
        active_id: group.active_id.clone(),
        split_id: group.split_id.clone(),
    };
    validate(&checkpoint)?;
    Ok(checkpoint)
}

#[tauri::command]
pub fn list_checkpoints<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
) -> Result<Vec<Checkpoint>, String> {
    {
        let mut managers = manager.0.lock().map_err(|e| e.to_string())?;
        require_public(inner_for(&mut managers, &window))?;
    }
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut checkpoints = read_store(&store_path(&app)?)?.checkpoints;
    checkpoints.sort_by_key(|checkpoint| std::cmp::Reverse(checkpoint.created_at));
    Ok(checkpoints)
}

#[derive(Deserialize)]
struct LivePage {
    url: String,
    title: String,
    #[serde(rename = "scrollY")]
    scroll_y: f64,
}

#[tauri::command]
pub async fn save_checkpoint<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    name: String,
    note: String,
) -> Result<Checkpoint, String> {
    // eval callbacks arrive on the native event loop. Never wait for them
    // on that thread or while holding the tab mutex used by navigation.
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<TabManager>();
        let (mut checkpoint, group_id) = {
            let mut managers = manager.0.lock().map_err(|e| e.to_string())?;
            let inner = inner_for(&mut managers, &window);
            (snapshot(inner, name, note)?, inner.active_group_id.clone())
        };
        // Schedule all reads before waiting; a slow page costs at most a
        // single shared timeout, regardless of the number of hot tabs.
        let (tx, rx) = mpsc::channel();
        let mut expected = 0;
        for tab in &checkpoint.tabs {
            if let Some(webview) = app.get_webview(&tab_label(&tab.id)) {
                let tx = tx.clone();
                let id = tab.id.clone();
                if webview.eval_with_callback(
                    "JSON.stringify({url:location.href,title:document.title,scrollY:Math.max(0,window.scrollY)})",
                    move |raw| { let _ = tx.send((id.clone(), raw)); },
                ).is_ok() { expected += 1; }
            }
        }
        drop(tx);
        let deadline = Instant::now() + Duration::from_millis(800);
        for _ in 0..expected {
            let Ok((id, raw)) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) else { break; };
            let page = serde_json::from_str::<String>(&raw).ok()
                .and_then(|json| serde_json::from_str::<LivePage>(&json).ok());
            if let (Some(page), Some(tab)) = (page, checkpoint.tabs.iter_mut().find(|tab| tab.id == id)) {
                if page.scroll_y.is_finite() && page.scroll_y >= 0.0 {
                    tab.url = page.url;
                    tab.title = page.title;
                    tab.scroll_y = page.scroll_y;
                }
            }
        }
        validate(&checkpoint)?;
        {
            let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
            let path = store_path(&app)?;
            let mut store = read_store(&path)?;
            if store.checkpoints.len() >= MAX_CHECKPOINTS {
                return Err("Checkpoint limit reached; delete an older checkpoint first".into());
            }
            store.checkpoints.push(checkpoint.clone());
            write_store(&path, &store)?;
        }
        // Carry lineage into the next checkpoint, even across restarts.
        let mut managers = manager.0.lock().map_err(|e| e.to_string())?;
        if let Some(inner) = managers.get_mut(window.label()) {
            if let Some(group) = inner.group_mut(&group_id) {
                group.checkpoint_parent_id = Some(checkpoint.id.clone());
                emit_tabs_changed(&app, window.label(), inner);
            }
        }
        Ok(checkpoint)
    }).await.map_err(|e| e.to_string())?
}

fn append_restored(
    inner: &mut Inner,
    checkpoint: &Checkpoint,
    name: String,
) -> Result<String, String> {
    require_public(inner)?;
    validate(checkpoint)?;
    inner.next_group_id = inner
        .next_group_id
        .checked_add(1)
        .ok_or("Space ID limit reached")?;
    let group_id = inner.next_group_id.to_string();
    let mut remap = HashMap::new();
    for tab in &checkpoint.tabs {
        let id = (NEXT_TAB_ID.fetch_add(1, Ordering::Relaxed) + 1).to_string();
        remap.insert(tab.id.clone(), id.clone());
        inner.tabs.push(TabEntry {
            id,
            url: tab.url.clone(),
            title: tab.title.clone(),
            scroll_y: tab.scroll_y,
            status: TabStatus::Hibernated,
            last_active_at: Instant::now(),
            group_id: group_id.clone(),
        });
    }
    inner.groups.push(Group {
        id: group_id.clone(),
        name,
        active_id: checkpoint
            .active_id
            .as_ref()
            .and_then(|id| remap.get(id))
            .cloned(),
        split_id: checkpoint
            .split_id
            .as_ref()
            .and_then(|id| remap.get(id))
            .cloned(),
        checkpoint_parent_id: Some(checkpoint.id.clone()),
    });
    Ok(group_id)
}

#[tauri::command]
pub fn restore_checkpoint<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    id: String,
    fork_name: Option<String>,
) -> Result<(), String> {
    let mut managers = manager.0.lock().map_err(|e| e.to_string())?;
    let inner = inner_for(&mut managers, &window);
    require_public(inner)?;
    let checkpoint = {
        let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
        read_store(&store_path(&app)?)?
            .checkpoints
            .into_iter()
            .find(|checkpoint| checkpoint.id == id)
            .ok_or("Checkpoint no longer exists")?
    };
    let name = match fork_name {
        Some(name) => bounded_text(&name, "Space name", 120, true)?,
        None => checkpoint.space_name.clone(),
    };
    let previous_group = inner.active_group_id.clone();
    let group_id = append_restored(inner, &checkpoint, name)?;
    // Do not enforce the hot cap here: original pages may contain unsaved
    // work. Only the restored active/split pair gets new webviews.
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

#[tauri::command]
pub fn delete_checkpoint<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    id: String,
) -> Result<(), String> {
    {
        let mut managers = manager.0.lock().map_err(|e| e.to_string())?;
        require_public(inner_for(&mut managers, &window))?;
    }
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    let path = store_path(&app)?;
    let mut store = read_store(&path)?;
    let old_len = store.checkpoints.len();
    store.checkpoints.retain(|checkpoint| checkpoint.id != id);
    if store.checkpoints.len() == old_len {
        return Err("Checkpoint no longer exists".into());
    }
    write_store(&path, &store)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Inner {
        let mut inner = Inner::default();
        inner.groups.push(Group {
            id: "2".into(),
            name: "Other".into(),
            active_id: Some("4200".into()),
            split_id: None,
            checkpoint_parent_id: None,
        });
        inner.next_group_id = 2;
        for (id, group, scroll) in [
            ("4100", "1", 125.5),
            ("4200", "2", 0.0),
            ("4300", "1", 912.0),
        ] {
            inner.tabs.push(TabEntry {
                id: id.into(),
                url: format!("https://example.com/{id}"),
                title: format!("Page {id}"),
                scroll_y: scroll,
                status: TabStatus::Hibernated,
                group_id: group.into(),
                last_active_at: Instant::now(),
            });
        }
        inner.active_group_mut().active_id = Some("4100".into());
        inner.active_group_mut().split_id = Some("4300".into());
        inner
    }

    #[test]
    fn snapshot_preserves_order_scroll_layout_and_only_current_space() {
        let saved = snapshot(&fixture(), "Research".into(), "Next step".into()).unwrap();
        assert_eq!(
            saved
                .tabs
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<Vec<_>>(),
            ["4100", "4300"]
        );
        assert_eq!(saved.tabs[0].scroll_y, 125.5);
        assert_eq!(saved.tabs[1].scroll_y, 912.0);
        assert_eq!(saved.active_id.as_deref(), Some("4100"));
        assert_eq!(saved.split_id.as_deref(), Some("4300"));
        let json = serde_json::to_string(&saved).unwrap();
        assert!(json.contains("\"scrollY\":125.5"));
        assert_eq!(serde_json::from_str::<Checkpoint>(&json).unwrap(), saved);
    }

    #[test]
    fn restore_remaps_ids_preserves_original_and_links_lineage() {
        let mut inner = fixture();
        let saved = snapshot(&inner, "Research".into(), String::new()).unwrap();
        let original = serde_json::to_string(&saved).unwrap();
        let group_id = append_restored(&mut inner, &saved, "Alternative".into()).unwrap();
        assert_eq!(inner.active_group_id, "1");
        assert_eq!(inner.tabs.len(), 5);
        let group = inner.group(&group_id).unwrap();
        assert_eq!(group.name, "Alternative");
        assert_eq!(
            group.checkpoint_parent_id.as_deref(),
            Some(saved.id.as_str())
        );
        assert_ne!(group.active_id, saved.active_id);
        assert_ne!(group.split_id, saved.split_id);
        assert_ne!(group.active_id, group.split_id);
        let restored: Vec<_> = inner
            .tabs
            .iter()
            .filter(|tab| tab.group_id == group_id)
            .collect();
        assert_eq!(restored.len(), 2);
        assert_eq!(restored[0].scroll_y, 125.5);
        assert!(restored
            .iter()
            .all(|tab| tab.status == TabStatus::Hibernated));
        assert_eq!(group.active_id.as_deref(), Some(restored[0].id.as_str()));
        assert_eq!(group.split_id.as_deref(), Some(restored[1].id.as_str()));
        assert_eq!(serde_json::to_string(&saved).unwrap(), original);
        inner.active_group_id = group_id;
        let child = snapshot(&inner, "Follow-up".into(), String::new()).unwrap();
        assert_eq!(child.parent_id, Some(saved.id));
    }

    #[test]
    fn private_windows_cannot_snapshot_or_restore() {
        let saved = snapshot(&fixture(), "Research".into(), String::new()).unwrap();
        let mut private = Inner::new_private();
        assert!(require_public(&private).is_err());
        assert!(snapshot(&private, "Secret".into(), String::new()).is_err());
        assert!(append_restored(&mut private, &saved, "Secret".into()).is_err());
        assert!(private.tabs.is_empty());
    }

    #[test]
    fn validates_names_urls_and_split_references() {
        assert!(snapshot(&fixture(), " ".into(), String::new()).is_err());
        assert!(snapshot(&fixture(), "x".repeat(121), String::new()).is_err());
        assert!(snapshot(&fixture(), "Name".into(), "x".repeat(2001)).is_err());
        let mut saved = snapshot(&fixture(), "Name".into(), String::new()).unwrap();
        saved.split_id = Some("missing".into());
        assert!(validate(&saved).is_err());
        saved.split_id = None;
        saved.tabs[0].url = "javascript:alert(1)".into();
        assert!(validate(&saved).is_err());
    }

    #[test]
    fn durable_store_roundtrip_and_corruption_is_never_empty() {
        let dir = std::env::temp_dir().join(format!("twig-checkpoint-test-{}", unique_id()));
        let path = dir.join("checkpoints.json");
        assert!(read_store(&path).unwrap().checkpoints.is_empty());
        let saved = snapshot(&fixture(), "Research".into(), String::new()).unwrap();
        write_store(
            &path,
            &Store {
                version: 1,
                checkpoints: vec![saved.clone()],
            },
        )
        .unwrap();
        assert_eq!(read_store(&path).unwrap().checkpoints, [saved]);
        // Replace an existing store as save/delete do, not just first-run creation.
        write_store(
            &path,
            &Store {
                version: 1,
                checkpoints: Vec::new(),
            },
        )
        .unwrap();
        assert!(read_store(&path).unwrap().checkpoints.is_empty());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::write(&path, b"{damaged").unwrap();
        assert!(read_store(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{damaged");
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn legacy_sessions_allow_missing_lineage_and_new_sessions_retain_it() {
        let legacy = r#"{"id":"1","name":"Research","active_id":null,"split_id":null}"#;
        let mut group: PersistedGroup = serde_json::from_str(legacy).unwrap();
        assert!(group.checkpoint_parent_id.is_none());
        group.checkpoint_parent_id = Some("checkpoint-a".into());
        let encoded = serde_json::to_string(&group).unwrap();
        assert_eq!(
            serde_json::from_str::<PersistedGroup>(&encoded)
                .unwrap()
                .checkpoint_parent_id,
            group.checkpoint_parent_id
        );
    }
}
