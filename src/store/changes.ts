import { create } from "zustand";
import type { PageChange } from "../lib/changes";

const MUTED_KEY = "twig:changes-muted";

function loadMuted(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(MUTED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function saveMuted(hosts: string[]) {
  try { localStorage.setItem(MUTED_KEY, JSON.stringify(hosts)); } catch { /* storage unavailable: mute lasts this session */ }
}

interface ChangeStore {
  /** Tab id -> what changed on the page it's showing. Absent = nothing to say. */
  byTab: Record<string, PageChange>;
  /** Tab whose changes panel is open. */
  openFor: string | null;
  muted: string[];
  set: (tabId: string, change: PageChange) => void;
  clear: (tabId: string) => void;
  /** Drops changes for tabs that closed or moved to another address. */
  prune: (tabs: { id: string; url: string }[]) => void;
  open: (tabId: string) => void;
  close: () => void;
  mute: (host: string) => void;
  unmute: (host: string) => void;
}

export const useChangeStore = create<ChangeStore>((set, get) => ({
  byTab: {},
  openFor: null,
  muted: loadMuted(),
  set: (tabId, change) => set((s) => ({ byTab: { ...s.byTab, [tabId]: change } })),
  clear: (tabId) => {
    if (!(tabId in get().byTab)) return;
    set((s) => {
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab, openFor: s.openFor === tabId ? null : s.openFor };
    });
  },
  prune: (tabs) => {
    const urls = new Map(tabs.map((t) => [t.id, t.url]));
    const stale = Object.entries(get().byTab).filter(([id, change]) => urls.get(id) !== change.url).map(([id]) => id);
    for (const id of stale) get().clear(id);
  },
  open: (tabId) => { if (get().byTab[tabId]) set({ openFor: tabId }); },
  close: () => set({ openFor: null }),
  mute: (host) => {
    if (!host || get().muted.includes(host)) return;
    const muted = [...get().muted, host].sort();
    saveMuted(muted);
    const byTab = Object.fromEntries(Object.entries(get().byTab).filter(([, c]) => {
      try { return new URL(c.url).hostname !== host; } catch { return true; }
    }));
    set({ muted, byTab, openFor: get().openFor && byTab[get().openFor!] ? get().openFor : null });
  },
  unmute: (host) => {
    const muted = get().muted.filter((h) => h !== host);
    saveMuted(muted);
    set({ muted });
  },
}));
