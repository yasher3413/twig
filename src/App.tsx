import { useEffect } from "react";
import { useTabStore } from "./store/tabs";
import "./App.css";

// Placeholder chrome for exercising the tab/webview architecture. The real
// vertical sidebar UI lands in the next milestone; this just proves tabs can
// be created, switched, and closed as separate webviews.
function App() {
  const { tabs, activeId, ready, init, newTab, switchTo, close } = useTabStore();

  useEffect(() => {
    init();
  }, [init]);

  return (
    <aside className="sidebar">
      <button className="new-tab" onClick={() => newTab()}>
        + New Tab
      </button>
      <ul className="tab-list">
        {ready && tabs.length === 0 && <li className="empty">No tabs open</li>}
        {tabs.map((tab) => (
          <li
            key={tab.id}
            className={tab.id === activeId ? "tab active" : "tab"}
            onClick={() => switchTo(tab.id)}
          >
            <span className="title">{tab.title}</span>
            <button
              className="close"
              onClick={(e) => {
                e.stopPropagation();
                close(tab.id);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export default App;
