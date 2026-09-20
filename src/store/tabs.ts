import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  activateTab,
  closeTab,
  createTab,
  listTabs,
  reorderTab,
  type Tab,
  type TabsChangedPayload,
} from "../lib/tabs";

interface TabStore {
  tabs: Tab[];
  activeId: string | null;
  ready: boolean;
  init: () => Promise<void>;
  newTab: (url?: string) => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  reorder: (id: string, toIndex: number) => Promise<void>;
}

export const useTabStore = create<TabStore>((set) => {
  function applyPayload(payload: TabsChangedPayload) {
    set({ tabs: payload.tabs, activeId: payload.activeId });
  }

  // Rust owns tab state; this listener is what keeps the store in sync
  // whenever it changes something on its own (create/activate/close).
  listen<TabsChangedPayload>("tabs-changed", (event) => applyPayload(event.payload));

  return {
    tabs: [],
    activeId: null,
    ready: false,
    async init() {
      applyPayload(await listTabs());
      set({ ready: true });
    },
    async newTab(url) {
      await createTab(url);
    },
    async switchTo(id) {
      await activateTab(id);
    },
    async close(id) {
      await closeTab(id);
    },
    async reorder(id, toIndex) {
      await reorderTab(id, toIndex);
    },
  };
});
