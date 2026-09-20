import { useEffect, useMemo, useRef, useState } from "react";
import { useTabStore } from "../store/tabs";
import { setOverlayActive } from "../lib/tabs";
import {
  addBookmark,
  isBookmarked,
  removeBookmark,
  searchBookmarks,
  searchHistory,
  type Bookmark,
  type HistoryEntry,
} from "../lib/db";
import "./CommandPalette.css";

interface ResultItem {
  key: string;
  label: string;
  sublabel?: string;
  run: () => void;
}

function looksLikeUrl(query: string): boolean {
  const q = query.trim();
  if (!q || /\s/.test(q)) return false;
  return q.includes(".") || q.startsWith("http://") || q.startsWith("https://");
}

export function CommandPalette() {
  const { tabs, activeId, newTab, switchTo, close, navigate } = useTabStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [historyMatches, setHistoryMatches] = useState<HistoryEntry[]>([]);
  const [bookmarkMatches, setBookmarkMatches] = useState<Bookmark[]>([]);
  const [activeBookmarked, setActiveBookmarked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setOverlayActive(open);
    if (open) {
      setQuery("");
      setSelected(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      if (activeTab) {
        isBookmarked(activeTab.url).then(setActiveBookmarked);
      } else {
        setActiveBookmarked(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    searchHistory(query.trim()).then((rows) => {
      if (!cancelled) setHistoryMatches(rows);
    });
    searchBookmarks(query.trim()).then((rows) => {
      if (!cancelled) setBookmarkMatches(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [open, query]);

  async function toggleActiveBookmark() {
    if (!activeTab) return;
    if (activeBookmarked) {
      await removeBookmark(activeTab.url);
    } else {
      await addBookmark(activeTab.url, activeTab.title);
    }
    setActiveBookmarked(!activeBookmarked);
  }

  const results = useMemo<ResultItem[]>(() => {
    const q = query.trim().toLowerCase();
    const items: ResultItem[] = [];

    for (const tab of tabs) {
      if (q && !tab.title.toLowerCase().includes(q) && !tab.url.toLowerCase().includes(q)) {
        continue;
      }
      items.push({
        key: `tab-${tab.id}`,
        label: tab.title,
        sublabel: tab.url,
        run: () => switchTo(tab.id),
      });
    }

    for (const bookmark of bookmarkMatches) {
      items.push({
        key: `bookmark-${bookmark.id}`,
        label: bookmark.title,
        sublabel: bookmark.url,
        run: () => newTab(bookmark.url),
      });
    }

    for (const entry of historyMatches) {
      items.push({
        key: `history-${entry.id}`,
        label: entry.title,
        sublabel: entry.url,
        run: () => newTab(entry.url),
      });
    }

    const commands: ResultItem[] = [
      { key: "cmd-new-tab", label: "New Tab", run: () => newTab() },
    ];
    if (activeId) {
      commands.push({
        key: "cmd-close-tab",
        label: "Close Active Tab",
        run: () => close(activeId),
      });
    }
    if (activeTab) {
      commands.push({
        key: "cmd-toggle-bookmark",
        label: activeBookmarked ? "Remove Bookmark" : "Bookmark This Tab",
        run: () => toggleActiveBookmark(),
      });
    }
    for (const cmd of commands) {
      if (!q || cmd.label.toLowerCase().includes(q)) {
        items.push(cmd);
      }
    }

    if (looksLikeUrl(query)) {
      const target = query.trim();
      items.push({
        key: "go-to-url",
        label: `Go to "${target}"`,
        run: () => (activeId ? navigate(activeId, target) : newTab(target)),
      });
    }

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tabs, activeId, activeTab, activeBookmarked, historyMatches, bookmarkMatches, switchTo, newTab, close, navigate]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  function runSelected() {
    const item = results[selected];
    if (!item) return;
    item.run();
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div className="palette-backdrop" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="Switch tabs, search, or go to a URL…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runSelected();
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        <ul className="palette-results">
          {results.length === 0 && <li className="palette-empty">No matches</li>}
          {results.map((item, index) => (
            <li
              key={item.key}
              className={index === selected ? "palette-item selected" : "palette-item"}
              onMouseEnter={() => setSelected(index)}
              onClick={() => {
                item.run();
                setOpen(false);
              }}
            >
              <span className="palette-item-label">{item.label}</span>
              {item.sublabel && <span className="palette-item-sublabel">{item.sublabel}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
