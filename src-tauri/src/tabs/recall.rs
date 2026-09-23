//! Plain-text capture and a bounded, best-effort jump on the live page.
use super::*;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) const CAPTURE_SCRIPT: &str = r#"(() => {
  const empty = () => JSON.stringify({u: location.href, t: document.title || '', b: ''});
  if (!document.body || document.designMode.toLowerCase() === 'on') return empty();
  const excluded = 'script,style,noscript,template,input,textarea,select,button,form,[contenteditable]:not([contenteditable="false" i]),[role="textbox" i],[hidden],[aria-hidden="true" i]';
  const hidden = el => {
    if (el.matches(excluded) || el.isContentEditable) return true;
    const style = getComputedStyle(el);
    return style.display === 'none' || style.visibility !== 'visible' || style.contentVisibility === 'hidden' || style.opacity === '0';
  };
  // Include the root and its ancestors: the entire body can be an editor.
  for (let el = document.body; el; el = el.parentElement) if (hidden(el)) return empty();
  const chunks = [];
  let length = 0, visited = 0;
  const append = text => {
    const piece = text.slice(0, 40000 - length);
    chunks.push(piece);
    length += piece.length;
  };
  const range = document.createRange();
  const walk = (node, depth) => {
    if (length >= 40000 || ++visited > 20000 || depth > 128) return;
    if (node.nodeType === Node.TEXT_NODE) {
      // Rendered rectangles also catch text in collapsed or non-rendered subtrees.
      range.selectNodeContents(node);
      if (range.getClientRects().length) append((node.nodeValue || '').slice(0, 40000 - length).replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || hidden(node)) return;
    const block = /^(P|DIV|SECTION|ARTICLE|LI|H[1-6]|BR|TR|BLOCKQUOTE|PRE)$/.test(node.tagName);
    if (block) append('\n');
    for (let child = node.firstChild; child && length < 40000 && visited < 20000; child = child.nextSibling) walk(child, depth + 1);
    if (block) append('\n');
  };
  walk(document.body, 0);
  let body = chunks.join('').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // A UTF-16 limit must not emit a lone leading surrogate at the boundary.
  if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
  return JSON.stringify({u: location.href, t: document.title || '', b: body});
})()"#;

pub(super) struct CaptureMetadata {
    pub captured_at: u64,
    pub space_id: String,
    pub space_name: String,
    pub session_id: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn public_url(url: &str) -> Result<tauri::Url, String> {
    if url.len() > 8192 || url.chars().any(char::is_control) {
        return Err("Invalid page address".into());
    }
    let parsed = tauri::Url::parse(url).map_err(|_| "Invalid page address")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Recall supports HTTP and HTTPS addresses without credentials".into());
    }
    Ok(parsed)
}

pub(super) fn capture_metadata(inner: &Inner, id: &str, url: &str) -> Option<CaptureMetadata> {
    if inner.is_private || public_url(url).is_err() {
        return None;
    }
    let tab = inner
        .tabs
        .iter()
        .find(|tab| tab.id == id && tab.url == url)?;
    let group = inner.group(&tab.group_id)?;
    static SESSION: OnceLock<String> = OnceLock::new();
    Some(CaptureMetadata {
        captured_at: now_ms(),
        space_id: group.id.clone(),
        space_name: group.name.clone(),
        session_id: SESSION
            .get_or_init(|| format!("{}-{}", std::process::id(), now_ms()))
            .clone(),
    })
}

fn passage_script(url: &str, passage: &str) -> Result<String, String> {
    if passage.chars().count() > 2000
        || passage
            .chars()
            .any(|c| c.is_control() && !c.is_whitespace())
    {
        return Err("Passages must contain at most 2,000 characters".into());
    }
    let query = passage.split_whitespace().collect::<Vec<_>>().join(" ");
    // JSON serialization keeps quotes, backticks and script-like text literal.
    let query = serde_json::to_string(&query).map_err(|e| e.to_string())?;
    let url = serde_json::to_string(url).map_err(|e| e.to_string())?;
    Ok(format!(
        r#"(() => {{
      if (window.top !== window || location.href !== {url}) return;
      const query = {query};
      if (!query) return;
      let attempts = 0;
      const find = () => {{
        if (location.href !== {url}) return;
        const selection = window.getSelection();
        // Do not replace a selection made by the reader while content loads.
        if (selection && !selection.isCollapsed) return;
        if (typeof window.find === 'function' && window.find(query, false, false, true, false, false, false)) return;
        if (++attempts < 12) setTimeout(find, 500);
      }};
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', find, {{once: true}});
      else find();
    }})()"#
    ))
}

#[tauri::command]
pub fn open_recalled_page<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    url: String,
    passage: String,
) -> Result<TabInfo, String> {
    let parsed = public_url(&url)?;
    let url = parsed.to_string();
    let script = passage_script(&url, &passage)?;
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);
    if inner.is_private {
        return Err("Recall is unavailable in private windows".into());
    }
    let info = open_tab_with_script(
        &app,
        &window,
        inner,
        url,
        derive_title(&parsed),
        Some(&script),
    )?;
    sync_visible_webviews(&app, &window, inner);
    focus_active(&app, inner);
    emit_tabs_changed(&app, window.label(), inner);
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_public_web_addresses() {
        assert!(public_url("https://example.com/article?q=test#passage").is_ok());
        for url in [
            "file:///tmp/page",
            "javascript:alert(1)",
            "https://user:password@example.com",
            "https://user@example.com",
            "https://example.com/\nsecret",
            "about:blank",
        ] {
            assert!(public_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn metadata_uses_owning_space_and_skips_private_or_stale_loads() {
        let mut inner = Inner::default();
        inner.groups.push(Group {
            id: "other".into(),
            name: "Research".into(),
            active_id: None,
            split_id: None,
            checkpoint_parent_id: None,
        });
        inner.tabs.push(TabEntry {
            id: "tab".into(),
            url: "https://example.com/".into(),
            title: "Example".into(),
            status: TabStatus::Hot,
            last_active_at: Instant::now(),
            scroll_y: 0.0,
            group_id: "other".into(),
        });
        let metadata = capture_metadata(&inner, "tab", "https://example.com/").unwrap();
        assert_eq!(metadata.space_id, "other");
        assert_eq!(metadata.space_name, "Research");
        assert!(metadata.captured_at > 0);
        assert_eq!(
            metadata.session_id,
            capture_metadata(&inner, "tab", "https://example.com/")
                .unwrap()
                .session_id
        );
        assert!(capture_metadata(&inner, "tab", "https://example.com/new").is_none());
        inner.is_private = true;
        assert!(capture_metadata(&inner, "tab", "https://example.com/").is_none());
    }

    #[test]
    fn passages_are_bounded_and_serialized_as_data() {
        let text = "\";alert(1);// ` ${danger} </script>";
        let script = passage_script("https://example.com/", text).unwrap();
        assert!(script.contains(&format!(
            "const query = {};",
            serde_json::to_string(text).unwrap()
        )));
        assert!(script.contains("++attempts < 12"));
        assert!(passage_script("https://example.com/", &"x".repeat(2001)).is_err());
        assert!(passage_script("https://example.com/", "bad\0query").is_err());
    }
}
