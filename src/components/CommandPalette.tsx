import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { emit } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
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
import { openCheckpoints } from "../lib/checkpoints";
import { openResearchPackages } from "../lib/research";
import { openRecall } from "../lib/recall";
import { useChangeStore } from "../store/changes";
import { useSnoozeStore } from "../store/snooze";
import { canSnooze } from "../lib/snooze-actions";
import { useStaleTabs } from "../lib/use-stale-tabs";
import { shouldSuggest } from "../lib/sweep";
import { displayAccel, getKeymap, openWelcome } from "../lib/onboarding";
import { Icon, type IconName } from "./Icon";
import { SiteMark, hostOf } from "./SiteMark";
import "./CommandPalette.css";

type Kind = "go" | "tab" | "bookmark" | "history" | "page" | "command";

interface Item {
  key: string;
  kind: Kind;
  label: string;
  /** Pages lead with their favicon; everything else with an icon. */
  url?: string;
  icon?: IconName;
  detail?: string;
  /** FTS5 snippet with the match wrapped in [[ ]]. */
  snippet?: string;
  shortcut?: string;
  run: () => void;
}

interface Section {
  id: string;
  title: string;
  items: Item[];
}

/** Palette command -> the menu action whose shortcut it should show. */
const COMMAND_MENU_IDS: Record<string, string> = {
  "cmd-new-tab": "new-tab",
  "cmd-reopen": "reopen-closed-tab",
  "cmd-private": "new-private-window",
  "cmd-bookmarks": "show-bookmarks",
  "cmd-history": "show-history",
  "cmd-strip": "toggle-tab-strip",
  "cmd-settings": "settings",
  "cmd-recall": "show-recall",
  "cmd-changes": "show-changes",
  "cmd-snooze": "snooze-tab",
  "cmd-save-checkpoint": "save-checkpoint",
  "cmd-checkpoints": "show-checkpoints",
  "cmd-research": "show-research-packages",
  "cmd-package": "package-current-space",
  "cmd-bookmark": "bookmark",
  "cmd-close": "close-tab",
};

function looksLikeUrl(query: string): boolean {
  const q = query.trim();
  if (!q || /\s/.test(q)) return false;
  return q.includes(".") || q.startsWith("http://") || q.startsWith("https://");
}

// FTS5 hands back the matched terms already marked. Showing them is the
// whole point of a full-text hit - it's why this row is here at all.
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[\[.*?\]\])/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("[[") ? <mark key={i}>{part.slice(2, -2)}</mark> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}

// The shell owns only whether the palette is open. Everything else lives in
// <Palette>, which exists only while it's showing - so a closed palette no
// longer rebuilds its result list every time any tab changes, and opening
// it starts from clean state instead of resetting stale state by effect.
export function CommandPalette() {
  const [open, setOpen] = useState(false);

  // Triggered via a native menu accelerator, not a page-level keydown
  // listener: the active tab's webview usually holds keyboard focus,
  // which is a separate context our chrome's own listeners can't see.
  useMenuAction(["command-palette"], () => setOpen((o) => !o));

  useEffect(() => {
    setOverlayActive(open, "palette");
  }, [open]);

  return open ? <Palette onClose={() => setOpen(false)} /> : null;
}

function Palette({ onClose }: { onClose: () => void }) {
  const { tabs, activeId, isPrivate, newTab, switchTo, close, navigate, toggleTabStrip, reopenClosed } =
    useTabStore(
      useShallow((s) => ({
        tabs: s.tabs,
        activeId: s.activeId,
        isPrivate: s.isPrivate,
        newTab: s.newTab,
        switchTo: s.switchTo,
        close: s.close,
        navigate: s.navigate,
        toggleTabStrip: s.toggleTabStrip,
        reopenClosed: s.reopenClosed,
      })),
    );
  const hasChange = useChangeStore((s) => (activeId ? !!s.byTab[activeId] : false));
  const stale = useStaleTabs();
  const dismissedUntil = useSnoozeStore((s) => s.dismissedUntil);
  const suggestSweep = shouldSuggest(stale, dismissedUntil, Date.now());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [pages, setPages] = useState<PageMatch[]>([]);
  const [activeBookmarked, setActiveBookmarked] = useState(false);
  // Shortcuts are customisable, so the labels come from the live keymap
  // rather than being written into each command.
  const [keymap, setKeymapLabels] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
    getKeymap()
      .then((all) => setKeymapLabels(Object.fromEntries(all.map((b) => [b.id, displayAccel(b.current).join("")]))))
      .catch(() => {});
    if (!isPrivate && activeTab && !isInternalUrl(activeTab.url)) {
      isBookmarked(activeTab.url).then(setActiveBookmarked);
    }
    // Once, on open: this reflects the page you opened the palette from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Three local queries per keystroke is cheap, but not free - and FTS5
  // is the slow one. A short pause lets a burst of typing settle first.
  useEffect(() => {
    if (isPrivate) return;
    const q = query.trim();
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.all([
        searchHistory(q, 6),
        searchBookmarks(q, 5),
        q ? searchPages(q, 6).catch(() => [] as PageMatch[]) : Promise.resolve([] as PageMatch[]),
      ]).then(([h, b, p]) => {
        if (cancelled) return;
        setHistory(h);
        setBookmarks(b);
        setPages(p);
      });
    }, q ? 70 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, isPrivate]);

  async function toggleActiveBookmark() {
    if (!activeTab || isInternalUrl(activeTab.url)) return;
    if (activeBookmarked) await removeBookmark(activeTab.url);
    else await addBookmark(activeTab.url, activeTab.title);
    setActiveBookmarked(!activeBookmarked);
  }

  const sections = useMemo<Section[]>(() => {
    const raw = query.trim();
    const q = raw.toLowerCase();
    const out: Section[] = [];
    const seen = new Set<string>();

    // A typed address goes first. It used to be appended after every
    // command, so Enter on "github.com" opened whatever history row
    // happened to rank top instead of the site you typed.
    if (looksLikeUrl(raw)) {
      out.push({
        id: "go",
        title: "Go",
        items: [
          {
            key: "go",
            kind: "go",
            label: raw,
            icon: "globe",
            detail: activeId ? "Open here" : "Open in a new tab",
            run: () => (activeId ? navigate(activeId, raw) : newTab(raw)),
          },
        ],
      });
    }

    const tabItems: Item[] = [];
    for (const tab of tabs) {
      const internal = isInternalUrl(tab.url);
      if (q && !tab.title.toLowerCase().includes(q) && (internal || !tab.url.toLowerCase().includes(q))) {
        continue;
      }
      if (!internal) seen.add(tab.url);
      tabItems.push({
        key: `tab-${tab.id}`,
        kind: "tab",
        label: tab.title || "New Tab",
        url: internal ? undefined : tab.url,
        icon: internal ? "plus" : undefined,
        detail: tab.id === activeId ? "Current" : internal ? undefined : hostOf(tab.url),
        run: () => switchTo(tab.id),
      });
    }
    if (tabItems.length) out.push({ id: "tabs", title: "Open tabs", items: tabItems });

    const markItems = bookmarks
      .filter((b) => !seen.has(b.url))
      .map<Item>((b) => {
        seen.add(b.url);
        return {
          key: `bookmark-${b.id}`,
          kind: "bookmark",
          label: b.title || hostOf(b.url),
          url: b.url,
          detail: hostOf(b.url),
          run: () => newTab(b.url),
        };
      });
    if (markItems.length) out.push({ id: "bookmarks", title: "Bookmarks", items: markItems });

    const historyItems = history
      .filter((h) => !seen.has(h.url))
      .map<Item>((h) => {
        seen.add(h.url);
        return {
          key: `history-${h.id}`,
          kind: "history",
          label: h.title || hostOf(h.url),
          url: h.url,
          detail: hostOf(h.url),
          run: () => newTab(h.url),
        };
      });
    if (historyItems.length) out.push({ id: "history", title: q ? "History" : "Recent", items: historyItems });

    // Matched on what the page said, not what it was called. Last among
    // places: an exact tab or bookmark is usually what you meant, and
    // this is for the ones you can only half remember.
    const pageItems = pages
      .filter((p) => !seen.has(p.url))
      .map<Item>((p) => ({
        key: `page-${p.url}`,
        kind: "page",
        label: p.title || hostOf(p.url),
        url: p.url,
        snippet: p.snippet,
        run: () => newTab(p.url),
      }));
    if (pageItems.length) out.push({ id: "pages", title: "In pages you've read", items: pageItems });

    const commands: Item[] = [
      { key: "cmd-new-tab", kind: "command", label: "New tab", icon: "plus", shortcut: "⌘T", run: () => newTab() },
      { key: "cmd-reopen", kind: "command", label: "Reopen closed tab", icon: "reload", shortcut: "⇧⌘T", run: () => reopenClosed() },
      { key: "cmd-private", kind: "command", label: "New private window", icon: "incognito", shortcut: "⇧⌘N", run: () => openPrivateWindow() },
      { key: "cmd-bookmarks", kind: "command", label: "Show bookmarks", icon: "star", shortcut: "⇧⌘O", run: () => emit("menu-action", "show-bookmarks") },
      { key: "cmd-history", kind: "command", label: "Show history", icon: "history", shortcut: "⌘Y", run: () => emit("menu-action", "show-history") },
      { key: "cmd-strip", kind: "command", label: "Toggle tab strip", icon: "split", shortcut: "⌘B", run: () => toggleTabStrip() },
      { key: "cmd-settings", kind: "command", label: "Settings", icon: "settings", shortcut: "⌘,", run: () => emit("menu-action", "settings") },
      { key: "cmd-shortcuts", kind: "command", label: "Customize keyboard shortcuts", icon: "settings", run: () => openWelcome("keys") },
      { key: "cmd-welcome", kind: "command", label: "Welcome to twig", icon: "star", run: () => openWelcome() },
    ];
    if (!isPrivate) {
      if (q) {
        commands.unshift({
          key: "cmd-recall-query",
          kind: "command",
          label: `Search saved passages for “${raw}”`,
          icon: "recall",
          run: () => openRecall(raw),
        });
      }
      commands.push(
        { key: "cmd-recall", kind: "command", label: "Recall a passage", icon: "recall", shortcut: "⇧⌘F", run: () => openRecall() },
        { key: "cmd-save-checkpoint", kind: "command", label: "Save checkpoint", icon: "fork", shortcut: "⇧⌘S", run: () => openCheckpoints(true) },
        { key: "cmd-checkpoints", kind: "command", label: "Show checkpoints", icon: "fork", shortcut: "⇧⌘H", run: () => openCheckpoints() },
        { key: "cmd-research", kind: "command", label: "Show research packages", icon: "package", shortcut: "⇧⌘P", run: () => void openResearchPackages() },
        { key: "cmd-package", kind: "command", label: "Package current space", icon: "package", shortcut: "⌥⌘P", run: () => void openResearchPackages("current") },
      );
      if (activeId && hasChange) {
        commands.unshift({ key: "cmd-changes", kind: "command", label: "Show what changed", icon: "recall", run: () => useChangeStore.getState().open(activeId) });
      }
      if (activeId && canSnooze(activeId)) {
        commands.push({ key: "cmd-snooze", kind: "command", label: "Snooze tab…", icon: "moon", shortcut: "⌥⌘S", run: () => useSnoozeStore.getState().openPicker(activeId) });
      }
      if (suggestSweep) {
        commands.push({ key: "cmd-sweep", kind: "command", label: `Review ${stale.length} untouched tabs`, icon: "history", run: () => useSnoozeStore.getState().openSweep() });
      }
    }
    if (activeTab && !isInternalUrl(activeTab.url) && !isPrivate) {
      commands.push({
        key: "cmd-bookmark",
        kind: "command",
        label: activeBookmarked ? "Remove bookmark" : "Bookmark this page",
        icon: activeBookmarked ? "star-filled" : "star",
        shortcut: "⌘D",
        run: () => void toggleActiveBookmark(),
      });
    }
    if (activeId) {
      commands.push({ key: "cmd-close", kind: "command", label: "Close tab", icon: "close", shortcut: "⌘W", run: () => close(activeId) });
    }
    for (const cmd of commands) {
      const menuId = COMMAND_MENU_IDS[cmd.key];
      if (menuId && menuId in keymap) cmd.shortcut = keymap[menuId] || undefined;
    }
    const matched = commands.filter((c) => c.key === "cmd-recall-query" || !q || c.label.toLowerCase().includes(q));
    if (matched.length) out.push({ id: "commands", title: "Commands", items: matched });

    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tabs, activeId, activeTab, activeBookmarked, history, bookmarks, pages, isPrivate, keymap, hasChange, suggestSweep, stale.length]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const current = flat[Math.min(selected, flat.length - 1)];

  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Arrowing past the visible rows used to leave the highlight off-screen.
  useEffect(() => {
    if (!current) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(current.key)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current]);

  function run(item: Item | undefined) {
    if (!item) return;
    item.run();
    onClose();
  }

  let index = -1;

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-field">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            spellCheck={false}
            autoComplete="off"
            placeholder="Search tabs, pages you've read, or type a command"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={current ? `palette-${current.key}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => Math.min(s + 1, flat.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(current);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>

        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {flat.length === 0 && (
            <p className="palette-empty">
              Nothing matches “{query.trim()}”. Try fewer words, or press ⏎ with an address to go there.
            </p>
          )}
          {sections.map((section) => (
            <div key={section.id} role="group" aria-labelledby={`palette-group-${section.id}`}>
              <div className="palette-group" id={`palette-group-${section.id}`}>
                {section.title}
              </div>
              {section.items.map((item) => {
                index += 1;
                const i = index;
                const active = current?.key === item.key;
                return (
                  <PaletteRow
                    key={item.key}
                    item={item}
                    active={active}
                    onHover={() => setSelected(i)}
                    onRun={() => run(item)}
                  >
                    {item.snippet ? <Snippet text={item.snippet} /> : null}
                  </PaletteRow>
                );
              })}
            </div>
          ))}
        </div>

        <footer className="palette-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>⏎</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </footer>
      </div>
    </div>
  );
}

function PaletteRow({
  item,
  active,
  onHover,
  onRun,
  children,
}: {
  item: Item;
  active: boolean;
  onHover: () => void;
  onRun: () => void;
  children: ReactNode;
}) {
  return (
    <div
      id={`palette-${item.key}`}
      data-key={item.key}
      role="option"
      aria-selected={active}
      className={active ? "palette-row active" : "palette-row"}
      onMouseMove={onHover}
      onMouseDown={(e) => {
        // mousedown so the input never blurs mid-click.
        e.preventDefault();
        onRun();
      }}
    >
      <span className="palette-lead">
        {item.url ? <SiteMark url={item.url} size={16} /> : <Icon name={item.icon ?? "search"} size={15} />}
      </span>
      <span className="palette-text">
        <span className="palette-label">{item.label}</span>
        {children && <span className="palette-snippet">{children}</span>}
      </span>
      {item.shortcut ? (
        <kbd className="palette-kbd">{item.shortcut}</kbd>
      ) : item.detail ? (
        <span className={item.detail === "Current" ? "palette-detail current" : "palette-detail"}>
          {item.detail}
        </span>
      ) : null}
    </div>
  );
}
