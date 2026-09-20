import { useEffect, useMemo, useRef, useState } from "react";
import { useTabStore } from "../store/tabs";
import { setOverlayActive } from "../lib/tabs";
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
  const inputRef = useRef<HTMLInputElement>(null);

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
    }
  }, [open]);

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
  }, [query, tabs, activeId, switchTo, newTab, close, navigate]);

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
