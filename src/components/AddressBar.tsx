import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTabStore } from "../store/tabs";
import { useSettingsStore } from "../store/settings";
import { goBack, goForward, isInternalUrl, reloadTab, setContentOffset } from "../lib/tabs";
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
import { openCheckpoints } from "../lib/checkpoints";
import { openResearchPackages } from "../lib/research";
import { openRecall } from "../lib/recall";

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

/// How a URL reads once the parts nobody types are stripped off, which is
/// also the form worth completing to: "https://www.github.com/x" -> the
/// "github.com/x" you'd actually have typed.
function typeableForm(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}

/// The shortest thing you've been to that starts with what you've typed,
/// or null. Case-insensitive to match, but returns the stored spelling so
/// the completion looks like the real URL.
function inlineCompletion(typed: string, urls: string[]): string | null {
  const probe = typed.toLowerCase();
  if (!probe || probe.includes(" ")) return null;
  let best: string | null = null;
  for (const url of urls) {
    const form = typeableForm(url);
    if (form.toLowerCase().startsWith(probe) && form.length > typed.length) {
      if (!best || form.length < best.length) best = form;
    }
  }
  return best;
}

// Sits in the strip the backend reserves above tab content (see
// ADDRESS_BAR_HEIGHT in src-tauri/src/tabs.rs) - the tab's own webview
// never covers this band, so it's safe to draw here.
export function AddressBar() {
  const { tabs, activeId, tabStripVisible, isPrivate, navigate } = useTabStore();
  const togglePanel = useSettingsStore((s) => s.togglePanel);
  const searchEngineId = useSettingsStore((s) => s.searchEngineId);
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  // `typed` is what you actually entered; `draft` is what's on screen,
  // which may carry an inline completion after it. Keeping them apart is
  // what stops a completion from being re-read as input and completed
  // again on the next pass.
  const [typed, setTyped] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayOn = useRef(false);
  // Deleting shouldn't re-complete: backspacing over a completion would
  // otherwise put it straight back.
  const allowComplete = useRef(true);
  const pendingSelect = useRef<[number, number] | null>(null);

  const engineName =
    SEARCH_ENGINES.find((e) => e.id === searchEngineId)?.label ?? SEARCH_ENGINES[0].label;

  const url = activeTab?.url ?? "";
  const internal = isInternalUrl(url);

  const [bookmarked, setBookmarked] = useState(false);

  useEffect(() => {
    if (!editing) {
      setDraft(internal ? "" : url);
      setTyped(internal ? "" : url);
    }
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

  // Build the suggestion list as you type. Suggestions wait for an actual
  // edit rather than appearing on focus: clicking into the bar selects the
  // current URL, and matching on that would pop the list open every time
  // you so much as clicked the field. Private windows get search only -
  // reading history there would defeat the point.
  useEffect(() => {
    const q = typed.trim();
    const untouched = q === (internal ? "" : url);
    if (!editing || !q || untouched) {
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
  }, [typed, editing, isPrivate, engineName, internal, url]);

  // Inline completion: finish the URL in place and leave the added part
  // selected, so typing over it replaces it and Tab or Enter takes it.
  useEffect(() => {
    if (!editing || !allowComplete.current) {
      setDraft(typed);
      return;
    }
    const pool = suggestions
      .filter((s) => s.kind !== "search")
      .map((s) => s.target);
    const completed = inlineCompletion(typed, pool);
    if (completed) {
      setDraft(typed + completed.slice(typed.length));
      pendingSelect.current = [typed.length, completed.length];
    } else {
      setDraft(typed);
    }
  }, [typed, suggestions, editing]);

  useEffect(() => {
    const range = pendingSelect.current;
    if (!range || !inputRef.current) return;
    pendingSelect.current = null;
    inputRef.current.setSelectionRange(range[0], range[1]);
  }, [draft]);

  // Tab content is a separate native webview stacked above the chrome, so
  // the dropdown needs room that isn't already spoken for. Rather than
  // hiding the page, push it down by exactly the height of the list and
  // draw into the gap - the page stays visible and keeps its scroll.
  const panelHeight = suggestions.length ? suggestions.length * 32 + 10 + 6 : 0;

  useEffect(() => {
    setContentOffset(editing ? panelHeight : 0);
    overlayOn.current = panelHeight > 0;
  }, [editing, panelHeight]);

  // Covers unmount and tab switches, where no blur event arrives.
  useEffect(() => {
    return () => {
      if (overlayOn.current) setContentOffset(0);
    };
  }, []);

  function releaseOverlay() {
    if (overlayOn.current) {
      overlayOn.current = false;
    }
    setContentOffset(0);
  }

  function commit(value?: string) {
    const target = (value ?? draft).trim();
    setSuggestions([]);
    allowComplete.current = true;
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
          onChange={(e) => {
            const kind = (e.nativeEvent as InputEvent).inputType || "";
            allowComplete.current = !kind.startsWith("delete");
            setTyped(e.target.value);
            setDraft(e.target.value);
          }}
          onBlur={() => {
            setEditing(false);
            setSuggestions([]);
            allowComplete.current = true;
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
              const chosen = highlighted > 0 ? suggestions[highlighted]?.target : draft;
              commit(chosen);
            } else if (e.key === "Tab" && draft !== typed) {
              // Accept the completion rather than leaving the field.
              e.preventDefault();
              setTyped(draft);
              inputRef.current?.setSelectionRange(draft.length, draft.length);
            } else if (e.key === "Escape") {
              setDraft(internal ? "" : url);
              setTyped(internal ? "" : url);
              setSuggestions([]);
              allowComplete.current = true;
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
      {!isPrivate && <button className="nav-button" title="Recall a passage (⇧⌘F)" aria-label="Open recall" onClick={() => openRecall()}><Icon name="recall" /></button>}

      {!isPrivate && (
        <button className="nav-button" title="Checkpoints (⇧⌘H)" aria-label="Open checkpoints" onClick={() => openCheckpoints()}>
          <Icon name="history" />
        </button>
      )}

      <button className="nav-button" title="Settings (⌘,)" onClick={togglePanel}>
        <Icon name="settings" />
      </button>
      {!isPrivate && <button className="nav-button" title="Research packages (⇧⌘P)" aria-label="Open research packages" onClick={() => void openResearchPackages()}><Icon name="package" /></button>}
    </div>
  );
}
