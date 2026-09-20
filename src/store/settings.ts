import { create } from "zustand";

export type ThemeMode = "system" | "light" | "dark";

export interface AccentSwatch {
  id: string;
  label: string;
  light: string;
  dark: string;
}

export const ACCENT_SWATCHES: AccentSwatch[] = [
  { id: "blue", label: "Blue", light: "#3b6fed", dark: "#6d93f7" },
  { id: "purple", label: "Purple", light: "#8452e0", dark: "#a689f0" },
  { id: "green", label: "Green", light: "#1f9d55", dark: "#4ade80" },
  { id: "orange", label: "Orange", light: "#e0752f", dark: "#f4a361" },
  { id: "pink", label: "Pink", light: "#d84a86", dark: "#f0729f" },
  { id: "gray", label: "Gray", light: "#5b5f66", dark: "#9a9ea6" },
];

const THEME_KEY = "twig:theme-mode";
const ACCENT_KEY = "twig:accent";

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
  panelOpen: boolean;
  init: () => void;
  setThemeMode: (mode: ThemeMode) => void;
  setAccent: (id: string) => void;
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

  function applyAccent(id: string) {
    const swatch = ACCENT_SWATCHES.find((s) => s.id === id) ?? ACCENT_SWATCHES[0];
    const hex = isDarkNow() ? swatch.dark : swatch.light;
    const root = document.documentElement;
    root.style.setProperty("--accent", hex);
    root.style.setProperty("--accent-tint", hexToRgba(hex, isDarkNow() ? 0.2 : 0.12));
  }

  return {
    themeMode: "system",
    accentId: "blue",
    panelOpen: false,
    togglePanel() {
      set((s) => ({ panelOpen: !s.panelOpen }));
    },
    closePanel() {
      set({ panelOpen: false });
    },
    init() {
      const storedTheme = (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? "system";
      const storedAccent = localStorage.getItem(ACCENT_KEY) ?? "blue";
      set({ themeMode: storedTheme, accentId: storedAccent });
      applyTheme(storedTheme);
      applyAccent(storedAccent);

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
  };
});
