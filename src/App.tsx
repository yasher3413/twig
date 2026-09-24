import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { onMenuAction } from "./lib/menu";
import { TabStrip } from "./components/TabStrip";
import { AddressBar } from "./components/AddressBar";
import { FindBar } from "./components/FindBar";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsPanel } from "./components/SettingsPanel";
import { NewTabPage } from "./components/NewTabPage";
import { Library } from "./components/Library";
import { Welcome } from "./components/Welcome";
import { Downloads } from "./components/Downloads";
import { Checkpoints } from "./components/Checkpoints";
import { ResearchPackages } from "./components/ResearchPackages";
import { Recall } from "./components/Recall";
import { Changes } from "./components/Changes";
import type { RecallCapture } from "./lib/recall-db";
import { useTabStore } from "./store/tabs";
import { useSettingsStore } from "./store/settings";
import { followLink, goBack, goForward, isNewTab, reloadTab, toggleReader, zoomTab } from "./lib/tabs";
import { indexPage } from "./lib/db";
import { checkForChange, watchChanges } from "./lib/change-watch";
import "./App.css";

function App() {
  // A tab with no URL has no webview of its own, so this is what fills the
  // window for it. Never during a split - that pairs two real pages.
  //
  // Selected as a boolean on purpose. App renders every piece of chrome and
  // none of it is memoised, so subscribing to the whole store here meant
  // every tabs-changed - fired on every navigation and every title update -
  // re-rendered the palette, library, settings and all the rest. Now App
  // only renders when this flips.
  const showNewTab = useTabStore((s) => {
    const active = s.tabs.find((t) => t.id === s.activeId);
    return !!active && isNewTab(active.url) && !s.splitId;
  });

  useEffect(() => {
    useSettingsStore.getState().init();

    const unlistenAction = onMenuAction((id) => {
      const store = useTabStore.getState();
      switch (id) {
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
        case "follow-link":
          if (store.activeId) followLink(store.activeId);
          break;
        case "toggle-reader":
          if (store.activeId) toggleReader(store.activeId);
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
            const dir = id === "zoom-in" ? 1 : id === "zoom-out" ? -1 : 0;
            zoomTab(store.activeId, dir);
          }
          break;
        case "next-tab":
        case "prev-tab": {
          const spaceTabs = store.tabs.filter((t) => t.groupId === store.activeGroupId);
          if (spaceTabs.length > 1 && store.activeId) {
            const at = spaceTabs.findIndex((t) => t.id === store.activeId);
            const step = id === "next-tab" ? 1 : -1;
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

    // Rust lifts text out of each page once it settles; the index lives
    // here because the database is only reachable from the chrome.
    const unlistenCapture = listen<RecallCapture>(
      "page-captured",
      (event) => {
        if (useTabStore.getState().isPrivate) return;
        const capture = event.payload;
        // Compare first: once indexed, this capture would be its own baseline.
        checkForChange(capture)
          .catch((cause) => console.warn("Change detection failed", cause))
          .finally(() => {
            indexPage(capture).catch((cause) => {
              window.dispatchEvent(new CustomEvent("twig:recall-index-error", { detail: String(cause) }));
            });
          });
      },
    );

    const unlistenGoto = listen<string>("menu-goto-tab", (event) => {
      const store = useTabStore.getState();
      const n = parseInt(event.payload, 10);
      const spaceTabs = store.tabs.filter((t) => t.groupId === store.activeGroupId);
      const target = spaceTabs[n - 1];
      if (target) store.switchTo(target.id);
    });

    return () => {
      unlistenAction();
      unlistenGoto.then((f) => f());
      unlistenCapture.then((f) => f());
    };
  }, []);

  useEffect(() => watchChanges(), []);

  return (
    <>
      <TabStrip />
      <AddressBar />
      {showNewTab && <NewTabPage />}
      <FindBar />
      <Library />
      <Welcome />
      <Downloads />
      <Checkpoints />
      <ResearchPackages />
      <Recall />
      <Changes />
      <CommandPalette />
      <SettingsPanel />
    </>
  );
}

export default App;
