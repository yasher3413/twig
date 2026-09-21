import { useEffect, useRef, useState } from "react";
import { useTabStore } from "../store/tabs";
import { useSettingsStore } from "../store/settings";
import { goBack, goForward, isInternalUrl, reloadTab } from "../lib/tabs";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { Icon } from "./Icon";
import "./AddressBar.css";

// Sits in the strip the backend reserves above tab content (see
// ADDRESS_BAR_HEIGHT in src-tauri/src/tabs.rs) - the tab's own webview
// never covers this band, so it's safe to draw here.
export function AddressBar() {
  const { tabs, activeId, tabStripVisible, isPrivate, navigate } = useTabStore();
  const togglePanel = useSettingsStore((s) => s.togglePanel);
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const url = activeTab?.url ?? "";
  const internal = isInternalUrl(url);

  useEffect(() => {
    if (!editing) setDraft(internal ? "" : url);
  }, [url, internal, editing]);

  function commit() {
    const target = draft.trim();
    if (activeId && target) navigate(activeId, target);
    setEditing(false);
    inputRef.current?.blur();
  }

  const secure = url.startsWith("https://");

  return (
    <div className="address-bar" style={{ top: tabStripVisible ? 38 : 0 }}>
      <span className="wordmark">
        twig
        {isPrivate && (
          <span className="private-badge" title="Private window">
            <Icon name="incognito" size={13} />
          </span>
        )}
      </span>

      <div className="nav-group">
        <button
          className="nav-button"
          title="Back"
          disabled={!activeTab}
          onClick={() => activeId && goBack(activeId)}
        >
          <Icon name="back" />
        </button>
        <button
          className="nav-button"
          title="Forward"
          disabled={!activeTab}
          onClick={() => activeId && goForward(activeId)}
        >
          <Icon name="forward" />
        </button>
        <button
          className="nav-button"
          title="Reload"
          disabled={!activeTab}
          onClick={() => activeId && reloadTab(activeId)}
        >
          <Icon name="reload" />
        </button>
      </div>

      <div className={editing ? "omnibox focused" : "omnibox"}>
        <span className="omnibox-lead" aria-hidden="true">
          {editing || internal ? (
            <Icon name="search" size={14} />
          ) : (
            <Icon name={secure ? "lock" : "globe"} size={14} />
          )}
        </span>
        <input
          ref={inputRef}
          className="omnibox-input"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={activeTab ? "Search Google or enter address" : "Open a tab to get started"}
          disabled={!activeTab}
          onFocus={(e) => {
            setEditing(true);
            e.target.select();
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(internal ? "" : url);
              setEditing(false);
              inputRef.current?.blur();
            }
          }}
        />
      </div>

      <SpaceSwitcher />

      <button className="nav-button" title="Settings (⌘,)" onClick={togglePanel}>
        <Icon name="settings" />
      </button>
    </div>
  );
}
