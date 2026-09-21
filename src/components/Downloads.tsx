import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTabStore } from "../store/tabs";
import { Icon } from "./Icon";
import "./Downloads.css";

interface Item {
  id: number;
  name: string;
  done: boolean;
  failed: boolean;
}

let nextId = 1;

// A download with no feedback is indistinguishable from a broken one, so
// this says what started and how it ended. Deliberately a transient
// notice rather than a manager: the file lands in ~/Downloads, which
// already has a perfectly good manager attached to it.
export function Downloads() {
  const tabStripVisible = useTabStore((s) => s.tabStripVisible);
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    const started = listen<string | null>("download-started", (event) => {
      const name = event.payload || "file";
      setItems((list) => [...list, { id: nextId++, name, done: false, failed: false }]);
    });

    const finished = listen<{ url: string; success: boolean }>("download-finished", (event) => {
      setItems((list) => {
        const at = list.findIndex((i) => !i.done);
        if (at === -1) return list;
        const next = [...list];
        next[at] = { ...next[at], done: true, failed: !event.payload.success };
        return next;
      });
    });

    return () => {
      started.then((f) => f());
      finished.then((f) => f());
    };
  }, []);

  // Clear finished entries a few seconds after they land.
  useEffect(() => {
    if (!items.some((i) => i.done)) return;
    const timer = setTimeout(() => {
      setItems((list) => list.filter((i) => !i.done));
    }, 6000);
    return () => clearTimeout(timer);
  }, [items]);

  if (items.length === 0) return null;

  return (
    <div className="downloads" style={{ top: (tabStripVisible ? 38 : 0) + 46 + 12 }}>
      {items.map((item) => (
        <div key={item.id} className={item.done ? "download done" : "download"}>
          <span className="download-icon">
            <Icon name={item.failed ? "close" : item.done ? "star-filled" : "down"} size={13} />
          </span>
          <span className="download-name">{item.name}</span>
          <span className="download-state">
            {item.failed ? "Failed" : item.done ? "Saved to Downloads" : "Downloading…"}
          </span>
          <button
            className="download-dismiss"
            title="Dismiss"
            onClick={() => setItems((list) => list.filter((i) => i.id !== item.id))}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
