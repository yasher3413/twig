import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTabStore } from "../store/tabs";
import { setOverlayActive } from "../lib/tabs";
import {
  deleteArchiveUrl,
  deleteHistoryUrl,
  removeBookmark,
  searchArchive,
  searchBookmarks,
  searchHistory,
  type ArchivedTab,
  type Bookmark,
  type HistoryEntry,
} from "../lib/db";
import { Icon } from "./Icon";
import { SiteMark, hostOf } from "./SiteMark";
import "./Library.css";

type Shelf = "bookmarks" | "history" | "archive";

interface Row {
  key: string;
  url: string;
  title: string;
  meta?: string;
}

function whenever(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Bookmarks, history and closed tabs are the same shape of thing - a list
// of pages worth getting back to - so they share one surface rather than
// three panels that would have been near-identical.
export function Library() {
  const { newTab } = useTabStore();
  const [open, setOpen] = useState(false);
  const [shelf, setShelf] = useState<Shelf>("bookmarks");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    const unlisten = listen<string>("menu-action", (event) => {
      if (event.payload === "show-bookmarks" || event.payload === "show-history") {
        const next: Shelf = event.payload === "show-bookmarks" ? "bookmarks" : "history";
        setOpen((was) => !(was && shelf === next));
        setShelf(next);
        setQuery("");
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  });

  useEffect(() => {
    setOverlayActive(open, "library");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const load = useCallback(async () => {
    if (shelf === "bookmarks") {
      const marks: Bookmark[] = await searchBookmarks(query.trim(), 300);
      setRows(
        marks.map((m) => ({
          key: `b-${m.id}`,
          url: m.url,
          title: m.title || hostOf(m.url),
        })),
      );
    } else if (shelf === "archive") {
      const closed: ArchivedTab[] = await searchArchive(query.trim(), 300);
      setRows(
        closed.map((c) => ({
          key: `a-${c.id}`,
          url: c.url,
          title: c.title || hostOf(c.url),
          meta: whenever(c.closedAt),
        })),
      );
    } else {
      const entries: HistoryEntry[] = await searchHistory(query.trim(), 300);
      setRows(
        entries.map((h) => ({
          key: `h-${h.id}`,
          url: h.url,
          title: h.title || hostOf(h.url),
          meta: whenever(h.visitedAt),
        })),
      );
    }
  }, [shelf, query]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  if (!open) return null;

  async function forget(url: string) {
    if (shelf === "bookmarks") await removeBookmark(url);
    else if (shelf === "archive") await deleteArchiveUrl(url);
    else await deleteHistoryUrl(url);
    load();
  }

  return (
    <div className="library-backdrop" onClick={() => setOpen(false)}>
      <div className="library" onClick={(e) => e.stopPropagation()}>
        <header className="library-head">
          <div className="segmented">
            <button
              className={shelf === "bookmarks" ? "segment selected" : "segment"}
              onClick={() => setShelf("bookmarks")}
            >
              Bookmarks
            </button>
            <button
              className={shelf === "history" ? "segment selected" : "segment"}
              onClick={() => setShelf("history")}
            >
              History
            </button>
            <button
              className={shelf === "archive" ? "segment selected" : "segment"}
              onClick={() => setShelf("archive")}
            >
              Closed
            </button>
          </div>

          <div className="library-search">
            <Icon name="search" size={14} />
            <input
              autoFocus
              value={query}
              spellCheck={false}
              placeholder={
                shelf === "bookmarks"
                  ? "Search bookmarks"
                  : shelf === "archive"
                    ? "Search closed tabs"
                    : "Search history"
              }
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <button className="library-close" title="Close (esc)" onClick={() => setOpen(false)}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="library-list">
          {rows.length === 0 && (
            <p className="library-empty">
              {query
                ? `Nothing matching “${query}”.`
                : shelf === "bookmarks"
                  ? "No bookmarks yet — ⌘D keeps the page you're on."
                  : shelf === "archive"
                    ? "Nothing closed yet. Tabs you close end up here."
                    : "No history yet."}
            </p>
          )}

          {rows.map((row) => (
            <div
              key={row.key}
              className="library-row"
              onClick={() => {
                newTab(row.url);
                setOpen(false);
              }}
            >
              <SiteMark url={row.url} size={20} />
              <span className="library-title">{row.title}</span>
              <span className="library-url">{hostOf(row.url)}</span>
              {row.meta && <span className="library-meta">{row.meta}</span>}
              <button
                className="library-forget"
                title={shelf === "bookmarks" ? "Remove bookmark" : "Forget this page"}
                onClick={(e) => {
                  e.stopPropagation();
                  forget(row.url);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
