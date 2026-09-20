import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  activateTab,
  closeGroup,
  closeTab,
  createGroup,
  createTab,
  listTabs,
  navigateTab,
  renameGroup,
  reopenClosedTab,
  reorderTab,
  setSplit,
  switchGroup,
  toggleSidebar as toggleSidebarCommand,
  type Group,
  type Tab,
  type TabsChangedPayload,
} from "../lib/tabs";
import { recordVisit } from "../lib/db";

interface TabStore {
  tabs: Tab[];
  activeId: string | null;
  splitId: string | null;
  groups: Group[];
  activeGroupId: string;
  sidebarVisible: boolean;
  isPrivate: boolean;
  ready: boolean;
  init: () => Promise<void>;
  newTab: (url?: string) => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  reorder: (id: string, toIndex: number) => Promise<void>;
  navigate: (id: string, url: string) => Promise<void>;
  toggleSplit: (id: string) => Promise<void>;
  newSpace: () => Promise<void>;
  switchSpace: (id: string) => Promise<void>;
  closeSpace: (id: string) => Promise<void>;
  renameSpace: (id: string, name: string) => Promise<void>;
  reopenClosed: () => Promise<void>;
  toggleSidebar: () => Promise<void>;
}

export const useTabStore = create<TabStore>((set, get) => {
  function applyPayload(payload: TabsChangedPayload) {
    set({
      tabs: payload.tabs,
      activeId: payload.activeId,
      splitId: payload.splitId,
      groups: payload.groups,
      activeGroupId: payload.activeGroupId,
      sidebarVisible: payload.sidebarVisible,
      isPrivate: payload.isPrivate,
    });
  }

  // Rust owns tab state; this listener is what keeps the store in sync
  // whenever it changes something on its own (create/activate/close).
  listen<TabsChangedPayload>("tabs-changed", (event) => applyPayload(event.payload));

  return {
    tabs: [],
    activeId: null,
    splitId: null,
    groups: [],
    activeGroupId: "",
    sidebarVisible: true,
    isPrivate: false,
    ready: false,
    async init() {
      applyPayload(await listTabs());
      set({ ready: true });
    },
    async newTab(url) {
      const tab = await createTab(url);
      if (!get().isPrivate) await recordVisit(tab.url, tab.title);
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
      const tab = await navigateTab(id, url);
      if (!get().isPrivate) await recordVisit(tab.url, tab.title);
    },
    async toggleSplit(id) {
      await setSplit(get().splitId === id ? null : id);
    },
    async newSpace() {
      await createGroup();
    },
    async switchSpace(id) {
      await switchGroup(id);
    },
    async closeSpace(id) {
      await closeGroup(id);
    },
    async renameSpace(id, name) {
      await renameGroup(id, name);
    },
    async reopenClosed() {
      const tab = await reopenClosedTab();
      if (tab && !get().isPrivate) await recordVisit(tab.url, tab.title);
    },
    async toggleSidebar() {
      await toggleSidebarCommand();
    },
  };
});
