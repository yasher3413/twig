import { create } from "zustand";
import { setSearchEngine } from "../lib/tabs";

export type ThemeMode = "system" | "light" | "dark";

export interface AccentSwatch {
  id: string;
  label: string;
  light: string;
  dark: string;
}

// Grounded in one palette - the same warm, organic material as the default
// moss accent - rather than generic hue-wheel swatches.
export const ACCENT_SWATCHES: AccentSwatch[] = [
  { id: "moss", label: "Moss", light: "#4b6b3a", dark: "#8fbb6e" },
  { id: "clay", label: "Clay", light: "#a85c32", dark: "#d98f5f" },
  { id: "ocean", label: "Ocean", light: "#2b6e7a", dark: "#6fb8c4" },
  { id: "plum", label: "Plum", light: "#6b4a82", dark: "#b58fd1" },
  { id: "honey", label: "Honey", light: "#a67c1d", dark: "#e0b24d" },
  { id: "slate", label: "Slate", light: "#52564c", dark: "#9a9e8f" },
];

export interface SearchEngine {
  id: string;
  label: string;
  template: string;
}

export const SEARCH_ENGINES: SearchEngine[] = [
  { id: "google", label: "Google", template: "https://www.google.com/search?q={}" },
  { id: "duckduckgo", label: "DuckDuckGo", template: "https://duckduckgo.com/?q={}" },
  { id: "brave", label: "Brave", template: "https://search.brave.com/search?q={}" },
  { id: "bing", label: "Bing", template: "https://www.bing.com/search?q={}" },
];

const THEME_KEY = "twig:theme-mode";
const ACCENT_KEY = "twig:accent";
const SEARCH_KEY = "twig:search-engine";

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

interface SettingsStore {
  themeMode: ThemeMode;
  accentId: string;
  searchEngineId: string;
  panelOpen: boolean;
  init: () => void;
  setThemeMode: (mode: ThemeMode) => void;
  setAccent: (id: string) => void;
  setSearchEngineId: (id: string) => void;
  togglePanel: () => void;
  closePanel: () => void;
}

export const useSettingsStore = create<SettingsStore>((set, get) => {
  function isDarkNow(): boolean {
    const mode = get().themeMode;
    return mode === "system" ? systemPrefersDark() : mode === "dark";
  }

  function applyTheme(mode: ThemeMode) {
    const root = document.documentElement;
    if (mode === "system") {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = mode;
    }
  }

  // URL building lives in Rust (normalize_url), so the choice has to be
  // pushed across rather than read from here.
  function applySearchEngine(id: string) {
    const engine = SEARCH_ENGINES.find((e) => e.id === id) ?? SEARCH_ENGINES[0];
    setSearchEngine(engine.template);
  }

  function applyAccent(id: string) {
    const swatch = ACCENT_SWATCHES.find((s) => s.id === id) ?? ACCENT_SWATCHES[0];
    const hex = isDarkNow() ? swatch.dark : swatch.light;
    const root = document.documentElement;
    root.style.setProperty("--accent", hex);
    root.style.setProperty("--accent-tint", hexToRgba(hex, isDarkNow() ? 0.2 : 0.12));
  }

  return {
    themeMode: "system",
    accentId: "moss",
    searchEngineId: "google",
    panelOpen: false,
    togglePanel() {
      set((s) => ({ panelOpen: !s.panelOpen }));
    },
    closePanel() {
      set({ panelOpen: false });
    },
    init() {
      const storedTheme = (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? "system";
      const storedAccent = localStorage.getItem(ACCENT_KEY) ?? "moss";
      const storedSearch = localStorage.getItem(SEARCH_KEY) ?? "google";
      set({ themeMode: storedTheme, accentId: storedAccent, searchEngineId: storedSearch });
      applyTheme(storedTheme);
      applyAccent(storedAccent);
      applySearchEngine(storedSearch);

      // Keep the resolved accent in sync if the OS theme changes while
      // following "system" (the accent has separate light/dark hexes).
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (get().themeMode === "system") applyAccent(get().accentId);
      });
    },
    setThemeMode(mode) {
      localStorage.setItem(THEME_KEY, mode);
      set({ themeMode: mode });
      applyTheme(mode);
      applyAccent(get().accentId);
    },
    setAccent(id) {
      localStorage.setItem(ACCENT_KEY, id);
      set({ accentId: id });
      applyAccent(id);
    },
    setSearchEngineId(id) {
      localStorage.setItem(SEARCH_KEY, id);
      set({ searchEngineId: id });
      applySearchEngine(id);
    },
  };
});
