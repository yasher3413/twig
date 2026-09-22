import { useEffect, useRef, useState } from "react";
import { useTabStore } from "../store/tabs";
import { setOverlayActive } from "../lib/tabs";
import { Icon } from "./Icon";
import "./SpaceSwitcher.css";

// Spaces used to be a row of chips down the sidebar. In a horizontal
// toolbar that row would compete with the tabs for the same axis, so it
// collapses to the current space's name plus a menu.
export function SpaceSwitcher() {
  const { groups, activeGroupId, tabs, tabStripVisible, newSpace, switchSpace, closeSpace, renameSpace } =
    useTabStore();
  const chromeHeight = (tabStripVisible ? 38 : 0) + 46;
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const active = groups.find((g) => g.id === activeGroupId);

  // Tab content lives in separate native webviews stacked above this one,
  // so no z-index here can draw over them - the page has to actually step
  // aside while the menu is open. Same mechanism the command palette uses.
  useEffect(() => {
    setOverlayActive(open, "spaces");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setEditingId(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setEditingId(null);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function commitRename() {
    if (editingId && draft.trim()) {
      renameSpace(editingId, draft.trim());
    }
    setEditingId(null);
  }

  return (
    <div className="space-switcher" ref={rootRef}>
      <button
        className={open ? "space-trigger open" : "space-trigger"}
        title="Switch space"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="space-trigger-name">{active?.name ?? "Space"}</span>
        <Icon name="chevron-down" size={13} />
      </button>

      {open && <div className="space-backdrop" style={{ top: chromeHeight }} />}

      {open && (
        <div className="space-menu">
          {groups.map((group) => {
            const count = tabs.filter((t) => t.groupId === group.id).length;
            return (
              <div
                key={group.id}
                className={group.id === activeGroupId ? "space-row active" : "space-row"}
                onClick={() => {
                  if (editingId !== group.id) {
                    switchSpace(group.id);
                    setOpen(false);
                  }
                }}
                onDoubleClick={() => {
                  setEditingId(group.id);
                  setDraft(group.name);
                }}
              >
                {editingId === group.id ? (
                  <input
                    autoFocus
                    className="space-rename"
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
                  <>
                    <span className="space-name">{group.name}</span>
                    <span className="space-count">{count}</span>
                    {groups.length > 1 && (
                      <button
                        className="space-close"
                        title="Close space"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeSpace(group.id);
                        }}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}

          <button
            className="space-add"
            onClick={() => {
              newSpace();
              setOpen(false);
            }}
          >
            <Icon name="plus" size={13} />
            New space
          </button>
        </div>
      )}
    </div>
  );
}
