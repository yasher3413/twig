import { useEffect, useRef, useState } from "react";
import { useTabStore } from "../store/tabs";
import { goBack, goForward, reloadTab } from "../lib/tabs";
import "./AddressBar.css";

// Sits in the strip the backend reserves above tab content (see
// TOP_BAR_HEIGHT in src-tauri/src/tabs.rs) - the tab's own webview never
// covers this area, so it's safe to draw here the same way the sidebar
// draws in its reserved column.
export function AddressBar() {
  const { tabs, activeId, sidebarVisible, navigate } = useTabStore();
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(activeTab?.url ?? "");
  }, [activeTab?.url, editing]);

  if (!activeTab) return null;

  function commit() {
    const target = draft.trim();
    if (activeId && target) navigate(activeId, target);
    setEditing(false);
    inputRef.current?.blur();
  }

  return (
    <div className="address-bar" style={{ left: sidebarVisible ? 240 : 0 }}>
      <button className="nav-button" title="Back" onClick={() => activeId && goBack(activeId)}>
        ‹
      </button>
      <button className="nav-button" title="Forward" onClick={() => activeId && goForward(activeId)}>
        ›
      </button>
      <button className="nav-button" title="Reload" onClick={() => activeId && reloadTab(activeId)}>
        ↻
      </button>
      <input
        ref={inputRef}
        className="address-input"
        value={draft}
        placeholder="Search or enter address"
        onFocus={(e) => {
          setEditing(true);
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(activeTab.url);
            setEditing(false);
            inputRef.current?.blur();
          }
        }}
      />
    </div>
  );
}
