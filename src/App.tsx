import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { useTabStore } from "./store/tabs";
import "./App.css";

function App() {
  useEffect(() => {
    const unlistenAction = listen<string>("menu-action", (event) => {
      const store = useTabStore.getState();
      switch (event.payload) {
        case "new-tab":
          store.newTab();
          break;
        case "close-tab":
          if (store.activeId) store.close(store.activeId);
          break;
        case "reopen-closed-tab":
          store.reopenClosed();
          break;
        case "toggle-sidebar":
          store.toggleSidebar();
          break;
        // "command-palette" and "find-in-page" are handled by those
        // components directly.
      }
    });

    const unlistenGoto = listen<string>("menu-goto-tab", (event) => {
      const store = useTabStore.getState();
      const n = parseInt(event.payload, 10);
      const spaceTabs = store.tabs.filter((t) => t.groupId === store.activeGroupId);
      const target = spaceTabs[n - 1];
      if (target) store.switchTo(target.id);
    });

    return () => {
      unlistenAction.then((f) => f());
      unlistenGoto.then((f) => f());
    };
  }, []);

  return (
    <>
      <Sidebar />
      <CommandPalette />
    </>
  );
}

export default App;
