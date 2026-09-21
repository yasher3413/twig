import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTabStore } from "../store/tabs";
import { useSettingsStore } from "../store/settings";
import { goBack, goForward, isInternalUrl, reloadTab, setOverlayActive } from "../lib/tabs";
import {
  addBookmark,
  autocomplete,
  isBookmarked,
  removeBookmark,
  searchBookmarks,
  type Bookmark,
  type HistoryEntry,
} from "../lib/db";
import { SEARCH_ENGINES } from "../store/settings";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { Icon } from "./Icon";
import "./AddressBar.css";

interface Suggestion {
  key: string;
  kind: "search" | "history" | "bookmark";
  label: string;
  detail?: string;
  target: string;
}

function looksLikeUrl(value: string): boolean {
  return value.includes("://") || (!value.includes(" ") && value.includes("."));
}

// Sits in the strip the backend reserves above tab content (see
// ADDRESS_BAR_HEIGHT in src-tauri/src/tabs.rs) - the tab's own webview
// never covers this band, so it's safe to draw here.
export function AddressBar() {
  const { tabs, activeId, tabStripVisible, isPrivate, navigate } = useTabStore();
  const togglePanel = useSettingsStore((s) => s.togglePanel);
  const searchEngineId = useSettingsStore((s) => s.searchEngineId);
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayOn = useRef(false);

  const engineName =
    SEARCH_ENGINES.find((e) => e.id === searchEngineId)?.label ?? SEARCH_ENGINES[0].label;

  const url = activeTab?.url ?? "";
  const internal = isInternalUrl(url);

  const [bookmarked, setBookmarked] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(internal ? "" : url);
  }, [url, internal, editing]);

  useEffect(() => {
    if (internal || isPrivate) {
      setBookmarked(false);
      return;
    }
    isBookmarked(url).then(setBookmarked);
  }, [url, internal, isPrivate]);

  async function toggleBookmark() {
    if (internal || isPrivate || !activeTab) return;
    if (bookmarked) {
      await removeBookmark(url);
    } else {
      await addBookmark(url, activeTab.title);
    }
    setBookmarked(!bookmarked);
  }

  useEffect(() => {
    const unlisten = listen<string>("menu-action", (event) => {
      if (event.payload === "focus-address") {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (event.payload === "bookmark") toggleBookmark();
    });
    return () => {
      unlisten.then((f) => f());
    };
  });

  // Build the suggestion list as you type. Private windows get search
  // only - reading history there would defeat the point.
  useEffect(() => {
    const q = draft.trim();
    if (!editing || !q) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      const [history, marks] = isPrivate
        ? [[] as HistoryEntry[], [] as Bookmark[]]
        : await Promise.all([autocomplete(q, 6), searchBookmarks(q, 3)]);
      if (cancelled) return;

      const seen = new Set<string>();
      const next: Suggestion[] = [];

      if (!looksLikeUrl(q)) {
        next.push({
          key: "search",
          kind: "search",
          label: q,
          detail: `Search ${engineName}`,
          target: q,
        });
      }

      for (const mark of marks) {
        if (seen.has(mark.url)) continue;
        seen.add(mark.url);
        next.push({
          key: `b-${mark.id}`,
          kind: "bookmark",
          label: mark.title || mark.url,
          detail: mark.url,
          target: mark.url,
        });
      }

      for (const row of history) {
        if (seen.has(row.url)) continue;
        seen.add(row.url);
        next.push({
          key: `h-${row.id}`,
          kind: "history",
          label: row.title || row.url,
          detail: row.url,
          target: row.url,
        });
      }

      if (looksLikeUrl(q) && !seen.has(q)) {
        next.unshift({ key: "direct", kind: "search", label: q, detail: "Go to site", target: q });
      }

      setSuggestions(next);
      setHighlighted(0);
    }, 90);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft, editing, isPrivate, engineName]);

  // Tab content is a separate native webview stacked above the chrome, so
  // the dropdown can only be seen if the page steps aside. Turning the
  // overlay back off refocuses the page, so that waits until blur -
  // toggling it per keystroke would yank the caret out of the field.
  useEffect(() => {
    const want = editing && suggestions.length > 0;
    if (want && !overlayOn.current) {
      overlayOn.current = true;
      setOverlayActive(true);
    }
  }, [editing, suggestions.length]);

  function releaseOverlay() {
    if (overlayOn.current) {
      overlayOn.current = false;
      setOverlayActive(false);
    }
  }

  function commit(value?: string) {
    const target = (value ?? draft).trim();
    setSuggestions([]);
    if (activeId && target) navigate(activeId, target);
    setEditing(false);
    releaseOverlay();
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
          onBlur={() => {
            setEditing(false);
            setSuggestions([]);
            releaseOverlay();
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && suggestions.length) {
              e.preventDefault();
              setHighlighted((i) => (i + 1) % suggestions.length);
            } else if (e.key === "ArrowUp" && suggestions.length) {
              e.preventDefault();
              setHighlighted((i) => (i - 1 + suggestions.length) % suggestions.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              commit(suggestions[highlighted]?.target);
            } else if (e.key === "Escape") {
              setDraft(internal ? "" : url);
              setSuggestions([]);
              setEditing(false);
              releaseOverlay();
              inputRef.current?.blur();
            }
          }}
        />
        {!internal && !isPrivate && (
          <button
            className={bookmarked ? "omnibox-star on" : "omnibox-star"}
            title={bookmarked ? "Remove bookmark (⌘D)" : "Bookmark this page (⌘D)"}
            onClick={toggleBookmark}
          >
            <Icon name={bookmarked ? "star-filled" : "star"} size={14} />
          </button>
        )}

        {editing && suggestions.length > 0 && (
          <ul className="omnibox-suggestions">
            {suggestions.map((s, i) => (
              <li
                key={s.key}
                className={i === highlighted ? "suggestion active" : "suggestion"}
                onMouseEnter={() => setHighlighted(i)}
                // mousedown, not click: blur would tear the list down first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(s.target);
                }}
              >
                <Icon
                  name={s.kind === "search" ? "search" : s.kind === "bookmark" ? "star" : "history"}
                  size={14}
                />
                <span className="suggestion-label">{s.label}</span>
                {s.detail && <span className="suggestion-detail">{s.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <SpaceSwitcher />

      <button className="nav-button" title="Settings (⌘,)" onClick={togglePanel}>
        <Icon name="settings" />
      </button>
    </div>
  );
}
