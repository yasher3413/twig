import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { findInPage } from "../lib/tabs";
import { useTabStore } from "../store/tabs";
import { Icon } from "./Icon";
import "./FindBar.css";

// Find-in-page stays visible over the active tab's content (unlike the
// command palette) so you can watch matches highlight as you type. It
// tucks into the top-right corner the way every browser puts it, clear of
// whatever chrome rows are currently showing.
export function FindBar() {
  const tabStripVisible = useTabStore((s) => s.tabStripVisible);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unlisten = listen<string>("menu-action", (event) => {
      if (event.payload === "find-in-page") {
        setOpen((o) => !o);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      findInPage("", false);
    }
  }, [open]);

  if (!open) return null;

  function search(backwards: boolean) {
    if (query) findInPage(query, backwards);
  }

  return (
    <div className="find-bar" style={{ top: (tabStripVisible ? 38 : 0) + 46 + 12 }}>
      <input
        ref={inputRef}
        className="find-input"
        value={query}
        spellCheck={false}
        placeholder="Find in page"
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value) findInPage(e.target.value, false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            search(e.shiftKey);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      <button className="find-nav" title="Previous match (⇧⏎)" onClick={() => search(true)}>
        <Icon name="up" size={14} />
      </button>
      <button className="find-nav" title="Next match (⏎)" onClick={() => search(false)}>
        <Icon name="down" size={14} />
      </button>
      <span className="find-divider" />
      <button className="find-close" title="Close (esc)" onClick={() => setOpen(false)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
