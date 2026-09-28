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
  toggleTabStrip as toggleTabStripCommand,
  type Group,
  type Tab,
  type TabsChangedPayload,
} from "../lib/tabs";
import { archiveTab, recordVisit, retitleVisit } from "../lib/db";
import { visitChanges } from "../lib/visits";

interface TabStore {
  tabs: Tab[];
  activeId: string | null;
  splitId: string | null;
  groups: Group[];
  activeGroupId: string;
  tabStripVisible: boolean;
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
  toggleTabStrip: () => Promise<void>;
}

export const useTabStore = create<TabStore>((set, get) => {
  function applyPayload(payload: TabsChangedPayload) {
    // History follows what tabs actually show - link clicks and redirects
    // included - rather than only what was typed. Restoring a session at
    // launch isn't browsing, so nothing is recorded until the store is ready.
    if (get().ready && !payload.isPrivate) {
      const { visits, retitles } = visitChanges(get().tabs, payload.tabs);
      for (const v of visits) recordVisit(v.url, v.title).catch(() => {});
      for (const v of retitles) retitleVisit(v.url, v.title).catch(() => {});
    }
    set({
      tabs: payload.tabs,
      activeId: payload.activeId,
      splitId: payload.splitId,
      groups: payload.groups,
      activeGroupId: payload.activeGroupId,
      tabStripVisible: payload.tabStripVisible,
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
    tabStripVisible: true,
    isPrivate: false,
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
      // Archive before closing, while the tab's url and title are still
      // known - afterwards there's nothing left to record.
      const tab = get().tabs.find((t) => t.id === id);
      if (tab && !get().isPrivate) await archiveTab(tab.url, tab.title).catch(() => {});
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
      await reopenClosedTab();
    },
    async toggleTabStrip() {
      await toggleTabStripCommand();
    },
  };
});
