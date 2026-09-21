import { useEffect, useMemo, useState } from "react";
import { useTabStore } from "../store/tabs";
import { Icon } from "./Icon";
import "./TabStrip.css";

// The horizontal tab row. Sits in the top strip the backend reserves (see
// TAB_STRIP_HEIGHT in src-tauri/src/tabs.rs); tab webviews start below it,
// so nothing here is ever covered by page content.
export function TabStrip() {
  const {
    tabs,
    activeId,
    splitId,
    activeGroupId,
    tabStripVisible,
    ready,
    init,
    newTab,
    switchTo,
    close,
    reorder,
    toggleSplit,
  } = useTabStore();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const spaceTabs = useMemo(
    () => tabs.filter((tab) => tab.groupId === activeGroupId),
    [tabs, activeGroupId],
  );

  useEffect(() => {
    init();
  }, [init]);

  function onDrop() {
    if (draggingId !== null && overIndex !== null) {
      reorder(draggingId, overIndex);
    }
    setDraggingId(null);
    setOverIndex(null);
  }

  if (!tabStripVisible) return null;

  return (
    <div className="tab-strip" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="tab-track">
        {ready && spaceTabs.length === 0 && (
          <span className="tab-empty">No tabs in this space</span>
        )}

        {spaceTabs.map((tab, index) => (
          <div
            key={tab.id}
            className={
              "tab" +
              (tab.id === activeId ? " active" : "") +
              (tab.id === splitId ? " split" : "") +
              (draggingId === tab.id ? " dragging" : "") +
              (tab.status === "hibernated" ? " hibernated" : "") +
              (overIndex === index ? " drop-before" : "")
            }
            draggable
            title={tab.title}
            onClick={(e) => {
              if ((e.altKey || e.metaKey) && tab.id !== activeId) {
                toggleSplit(tab.id);
              } else {
                switchTo(tab.id);
              }
            }}
            onDragStart={() => setDraggingId(tab.id)}
            onDragEnd={() => {
              setDraggingId(null);
              setOverIndex(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOverIndex(index);
            }}
          >
            <span
              className="tab-dot"
              title={tab.status === "hibernated" ? "Sleeping — click to wake" : undefined}
            />
            <span className="tab-title">{tab.title}</span>
            <button
              className="tab-action tab-split"
              title={tab.id === splitId ? "Remove from split view" : "Open in split view"}
              onClick={(e) => {
                e.stopPropagation();
                toggleSplit(tab.id);
              }}
            >
              <Icon name="split" size={13} />
            </button>
            <button
              className="tab-action tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                close(tab.id);
              }}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}

        <div
          className={overIndex === spaceTabs.length ? "tab-tail drop-before" : "tab-tail"}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOverIndex(spaceTabs.length);
          }}
        />
      </div>

      <button className="tab-new" title="New tab (⌘T)" onClick={() => newTab()}>
        <Icon name="plus" size={15} />
      </button>
    </div>
  );
}
