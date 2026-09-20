import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  activateTab,
  closeTab,
  createTab,
  listTabs,
  navigateTab,
  reorderTab,
  setSplit,
  type Tab,
  type TabsChangedPayload,
} from "../lib/tabs";

interface TabStore {
  tabs: Tab[];
  activeId: string | null;
  splitId: string | null;
  ready: boolean;
  init: () => Promise<void>;
  newTab: (url?: string) => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  reorder: (id: string, toIndex: number) => Promise<void>;
  navigate: (id: string, url: string) => Promise<void>;
  toggleSplit: (id: string) => Promise<void>;
}

export const useTabStore = create<TabStore>((set, get) => {
  function applyPayload(payload: TabsChangedPayload) {
    set({ tabs: payload.tabs, activeId: payload.activeId, splitId: payload.splitId });
  }

  // Rust owns tab state; this listener is what keeps the store in sync
  // whenever it changes something on its own (create/activate/close).
  listen<TabsChangedPayload>("tabs-changed", (event) => applyPayload(event.payload));

  return {
    tabs: [],
    activeId: null,
    splitId: null,
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
    async navigate(id, url) {
      await navigateTab(id, url);
    },
    async toggleSplit(id) {
      await setSplit(get().splitId === id ? null : id);
    },
  };
});
