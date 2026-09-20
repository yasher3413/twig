import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { findInPage } from "../lib/tabs";
import "./FindBar.css";

// Find-in-page stays visible over the active tab's content (unlike the
// command palette) so you can see matches highlighted live - it lives in
// the sidebar's own space instead of a full-window overlay, since a
// floating overlay here would need to hide the very page you're searching.
export function FindBar() {
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
    <div className="find-bar">
      <input
        ref={inputRef}
        className="find-input"
        value={query}
        placeholder="Find in page…"
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
      <button className="find-nav" title="Previous match" onClick={() => search(true)}>
        ↑
      </button>
      <button className="find-nav" title="Next match" onClick={() => search(false)}>
        ↓
      </button>
      <button className="find-close" title="Close" onClick={() => setOpen(false)}>
        ×
      </button>
    </div>
  );
}
