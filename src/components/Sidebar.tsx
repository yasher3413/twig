import { useEffect, useMemo, useState } from "react";
import { useTabStore } from "../store/tabs";
import { SpaceSwitcher } from "./SpaceSwitcher";
import "./Sidebar.css";

export function Sidebar() {
  const {
    tabs,
    activeId,
    splitId,
    activeGroupId,
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

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="wordmark">twig</span>
        <button className="icon-button" title="New tab" onClick={() => newTab()}>
          +
        </button>
      </div>

      <SpaceSwitcher />

      <ul className="tab-list" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        {ready && spaceTabs.length === 0 && <li className="empty">No tabs open</li>}

        {spaceTabs.map((tab, index) => (
          <li key={tab.id}>
            {overIndex === index && <div className="drop-indicator" />}
            <div
              className={
                "tab" +
                (tab.id === activeId ? " active" : "") +
                (tab.id === splitId ? " split" : "") +
                (draggingId === tab.id ? " dragging" : "") +
                (tab.status === "hibernated" ? " hibernated" : "")
              }
              draggable
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
              {tab.status === "hibernated" && (
                <span className="status-dot" title="Hibernated — click to wake" />
              )}
              <span className="title">{tab.title}</span>
              {tab.id !== activeId && (
                <button
                  className={tab.id === splitId ? "icon-button split-toggle on" : "icon-button split-toggle"}
                  title={tab.id === splitId ? "Remove from split view" : "Open in split view"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSplit(tab.id);
                  }}
                >
                  split
                </button>
              )}
              <button
                className="icon-button close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  close(tab.id);
                }}
              >
                ×
              </button>
            </div>
          </li>
        ))}

        <li
          className="drop-zone"
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOverIndex(spaceTabs.length);
          }}
        >
          {overIndex === spaceTabs.length && <div className="drop-indicator" />}
        </li>
      </ul>
    </aside>
  );
}
