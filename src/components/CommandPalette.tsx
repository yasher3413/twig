import { useEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { useTabStore } from "../store/tabs";
import { isInternalUrl, openPrivateWindow, setOverlayActive } from "../lib/tabs";
import {
  addBookmark,
  isBookmarked,
  removeBookmark,
  searchBookmarks,
  searchHistory,
  searchPages,
  type Bookmark,
  type HistoryEntry,
  type PageMatch,
} from "../lib/db";
import { useMenuAction } from "../lib/menu";
import "./CommandPalette.css";
import { openCheckpoints } from "../lib/checkpoints";
import { openResearchPackages } from "../lib/research";
import { openRecall } from "../lib/recall";

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
  const { tabs, activeId, isPrivate, newTab, switchTo, close, navigate, toggleTabStrip, reopenClosed } =
    useTabStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [historyMatches, setHistoryMatches] = useState<HistoryEntry[]>([]);
  const [bookmarkMatches, setBookmarkMatches] = useState<Bookmark[]>([]);
  const [pageMatches, setPageMatches] = useState<PageMatch[]>([]);
  const [activeBookmarked, setActiveBookmarked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  // Triggered via a native menu accelerator, not a page-level keydown
  // listener: the active tab's webview usually holds keyboard focus,
  // which is a separate context our chrome's own listeners can't see.
  useMenuAction(["command-palette"], () => setOpen((o) => !o));

  useEffect(() => {
    setOverlayActive(open, "palette");
    if (open) {
      setQuery("");
      setSelected(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      if (!isPrivate && activeTab && !isInternalUrl(activeTab.url)) {
        isBookmarked(activeTab.url).then(setActiveBookmarked);
      } else {
        setActiveBookmarked(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (isPrivate) {
      setHistoryMatches([]); setBookmarkMatches([]); setPageMatches([]);
      return;
    }
    let cancelled = false;
    searchHistory(query.trim()).then((rows) => {
      if (!cancelled) setHistoryMatches(rows);
    });
    searchBookmarks(query.trim()).then((rows) => {
      if (!cancelled) setBookmarkMatches(rows);
    });
    searchPages(query.trim()).then((rows) => {
      if (!cancelled) setPageMatches(rows);
    }).catch(() => {
      if (!cancelled) setPageMatches([]);
    });
    return () => {
      cancelled = true;
    };
  }, [open, query, isPrivate]);

  async function toggleActiveBookmark() {
    if (!activeTab || isInternalUrl(activeTab.url)) return;
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
      const internal = isInternalUrl(tab.url);
      if (q && !tab.title.toLowerCase().includes(q) && !(!internal && tab.url.toLowerCase().includes(q))) {
        continue;
      }
      items.push({
        key: `tab-${tab.id}`,
        label: tab.title,
        sublabel: internal ? undefined : tab.url,
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

    // Pages matched on their actual text rather than their title. Shown
    // last: an exact tab or bookmark is usually what you meant, and this
    // is for the ones you can only half remember.
    const seen = new Set(items.map((i) => i.sublabel));
    for (const page of pageMatches) {
      if (seen.has(page.url)) continue;
      items.push({
        key: `page-${page.url}`,
        label: page.title || page.url,
        sublabel: page.snippet.replace(/\[\[|\]\]/g, ""),
        run: () => newTab(page.url),
      });
    }

    // The palette should be able to do the things the menus can, not just
    // navigate to places.
    const commands: ResultItem[] = [
      { key: "cmd-new-tab", label: "New Tab", sublabel: "⌘T", run: () => newTab() },
      {
        key: "cmd-new-private-window",
        label: "New Private Window",
        sublabel: "⇧⌘N",
        run: () => openPrivateWindow(),
      },
      {
        key: "cmd-bookmarks",
        label: "Show Bookmarks",
        sublabel: "⇧⌘O",
        run: () => emit("menu-action", "show-bookmarks"),
      },
      {
        key: "cmd-history",
        label: "Show History",
        sublabel: "⌘Y",
        run: () => emit("menu-action", "show-history"),
      },
      {
        key: "cmd-settings",
        label: "Settings",
        sublabel: "⌘,",
        run: () => emit("menu-action", "settings"),
      },
      {
        key: "cmd-toggle-strip",
        label: "Toggle Tab Strip",
        sublabel: "⌘B",
        run: () => toggleTabStrip(),
      },
      {
        key: "cmd-reopen",
        label: "Reopen Closed Tab",
        sublabel: "⇧⌘T",
        run: () => reopenClosed(),
      },
    ];
    if (!isPrivate) {
      commands.push(
        { key: "cmd-recall", label: "Recall a Passage", sublabel: "⇧⌘F", run: () => openRecall() },
        { key: "cmd-checkpoints", label: "Show Checkpoints", sublabel: "⇧⌘H", run: () => openCheckpoints() },
        { key: "cmd-save-checkpoint", label: "Save Checkpoint", sublabel: "⇧⌘S", run: () => openCheckpoints(true) },
        { key: "cmd-research", label: "Show Research Packages", sublabel: "⇧⌘P", run: () => { void openResearchPackages(); } },
        { key: "cmd-package-space", label: "Package Current Space", sublabel: "⌥⌘P", run: () => { void openResearchPackages("current"); } },
      );
      if (q) items.push({ key: "recall-query", label: `Search saved passages for “${query.trim()}”`, run: () => openRecall(query.trim()) });
    }
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
  }, [query, tabs, activeId, activeTab, activeBookmarked, historyMatches, bookmarkMatches, pageMatches, switchTo, newTab, close, navigate, toggleTabStrip, reopenClosed, isPrivate]);

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
