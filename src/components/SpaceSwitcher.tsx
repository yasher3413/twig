import { useState } from "react";
import { useTabStore } from "../store/tabs";
import "./SpaceSwitcher.css";

export function SpaceSwitcher() {
  const { groups, activeGroupId, newSpace, switchSpace, closeSpace, renameSpace } = useTabStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function commitRename() {
    if (editingId && draft.trim()) {
      renameSpace(editingId, draft.trim());
    }
    setEditingId(null);
  }

  return (
    <div className="space-switcher">
      {groups.map((group) => (
        <div
          key={group.id}
          className={group.id === activeGroupId ? "space-pill active" : "space-pill"}
          onClick={() => switchSpace(group.id)}
          onDoubleClick={() => {
            setEditingId(group.id);
            setDraft(group.name);
          }}
        >
          {editingId === group.id ? (
            <input
              autoFocus
              className="space-pill-input"
              value={draft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditingId(null);
              }}
            />
          ) : (
            <span className="space-pill-name">{group.name}</span>
          )}
          {groups.length > 1 && (
            <button
              className="space-pill-close"
              title="Close space"
              onClick={(e) => {
                e.stopPropagation();
                closeSpace(group.id);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button className="space-pill-add" title="New space" onClick={() => newSpace()}>
        +
      </button>
    </div>
  );
}
