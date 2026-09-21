import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { TabStrip } from "./components/TabStrip";
import { AddressBar } from "./components/AddressBar";
import { FindBar } from "./components/FindBar";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsPanel } from "./components/SettingsPanel";
import { NewTabPage } from "./components/NewTabPage";
import { useTabStore } from "./store/tabs";
import { useSettingsStore } from "./store/settings";
import { goBack, goForward, isNewTab, reloadTab, zoomTab } from "./lib/tabs";
import "./App.css";

function App() {
  const { tabs, activeId, splitId } = useTabStore();
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  // A tab with no URL has no webview of its own, so this is what fills the
  // window for it. Never during a split - that pairs two real pages.
  const showNewTab = !!activeTab && isNewTab(activeTab.url) && !splitId;

  useEffect(() => {
    useSettingsStore.getState().init();

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
        case "toggle-tab-strip":
          store.toggleTabStrip();
          break;
        case "reload":
          if (store.activeId) reloadTab(store.activeId);
          break;
        case "go-back":
          if (store.activeId) goBack(store.activeId);
          break;
        case "go-forward":
          if (store.activeId) goForward(store.activeId);
          break;
        case "zoom-in":
        case "zoom-out":
        case "zoom-reset":
          if (store.activeId) {
            const dir = event.payload === "zoom-in" ? 1 : event.payload === "zoom-out" ? -1 : 0;
            zoomTab(store.activeId, dir);
          }
          break;
        case "next-tab":
        case "prev-tab": {
          const spaceTabs = store.tabs.filter((t) => t.groupId === store.activeGroupId);
          if (spaceTabs.length > 1 && store.activeId) {
            const at = spaceTabs.findIndex((t) => t.id === store.activeId);
            const step = event.payload === "next-tab" ? 1 : -1;
            // Wraps, the way every browser's tab cycling does.
            const next = (at + step + spaceTabs.length) % spaceTabs.length;
            store.switchTo(spaceTabs[next].id);
          }
          break;
        }
        // "command-palette", "find-in-page", "focus-address", "bookmark",
        // and "settings" are handled by the components that own them.
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
      <TabStrip />
      <AddressBar />
      {showNewTab && <NewTabPage />}
      <FindBar />
      <CommandPalette />
      <SettingsPanel />
    </>
  );
}

export default App;
