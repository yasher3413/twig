import { useEffect, useRef, useState } from "react";
import { useTabStore } from "../store/tabs";
import { historyCount, topSites, searchBookmarks, type Bookmark, type HistoryEntry } from "../lib/db";
import { Icon } from "./Icon";
import { SiteMark, hostOf } from "./SiteMark";
import "./NewTabPage.css";

// Drawn by the chrome webview rather than loaded into the tab's own
// webview. That's what lets it read local history/bookmarks at all - a
// page inside a tab webview has no access to them - and it's why an empty
// tab holds no webview and costs no memory until you navigate.
export function NewTabPage() {
  const { tabs, activeId, isPrivate, tabStripVisible, navigate } = useTabStore();
  const chromeHeight = (tabStripVisible ? 38 : 0) + 46;
  const [query, setQuery] = useState("");
  const [sites, setSites] = useState<HistoryEntry[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const sleeping = tabs.filter((t) => t.status === "hibernated").length;

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [activeId]);

  useEffect(() => {
    if (isPrivate) return;
    let cancelled = false;
    topSites(8).then((rows) => !cancelled && setSites(rows));
    searchBookmarks("", 6).then((rows) => !cancelled && setBookmarks(rows));
    historyCount().then((n) => !cancelled && setPageCount(n));
    return () => {
      cancelled = true;
    };
  }, [isPrivate, activeId]);

  function go(target: string) {
    if (activeId && target.trim()) navigate(activeId, target.trim());
  }

  return (
    <div className="newtab" style={{ top: chromeHeight }}>
      <div className="newtab-inner">
        <h1 className="newtab-mark">twig</h1>

        <form
          className="newtab-search"
          onSubmit={(e) => {
            e.preventDefault();
            go(query);
          }}
        >
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={query}
            spellCheck={false}
            autoComplete="off"
            placeholder="Search Google or enter address"
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>

        {isPrivate ? (
          <p className="newtab-note">
            <Icon name="incognito" size={14} />
            Nothing in this window is saved — no history, no cookies left behind.
          </p>
        ) : (
          <>
            {sites.length > 0 && (
              <section className="newtab-section">
                <h2>Most visited</h2>
                <div className="site-grid">
                  {sites.map((site) => (
                    <button key={site.id} className="site" onClick={() => go(site.url)}>
                      <SiteMark url={site.url} />
                      <span className="site-host">{hostOf(site.url)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {bookmarks.length > 0 && (
              <section className="newtab-section">
                <h2>Bookmarks</h2>
                <div className="bookmark-row">
                  {bookmarks.map((mark) => (
                    <button key={mark.id} className="bookmark" onClick={() => go(mark.url)}>
                      <SiteMark url={mark.url} />
                      <span>{mark.title || hostOf(mark.url)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {sites.length === 0 && (
              <p className="newtab-note">
                Pages you visit are saved locally, on this machine only. They&apos;ll show up
                here, and ⌘K searches them.
              </p>
            )}
          </>
        )}
      </div>

      {/* The product's whole thesis, stated quietly rather than sold. */}
      <footer className="newtab-stat">
        {sleeping > 0 && (
          <span>
            {sleeping} {sleeping === 1 ? "tab" : "tabs"} asleep
          </span>
        )}
        {!isPrivate && pageCount > 0 && (
          <span>
            {pageCount.toLocaleString()} {pageCount === 1 ? "page" : "pages"} remembered
          </span>
        )}
      </footer>
    </div>
  );
}
