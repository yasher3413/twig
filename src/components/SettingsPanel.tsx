import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { setOverlayActive } from "../lib/tabs";
import { ACCENT_SWATCHES, useSettingsStore, type ThemeMode } from "../store/settings";
import "./SettingsPanel.css";

const THEME_OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export function SettingsPanel() {
  const { panelOpen, togglePanel, closePanel, themeMode, accentId, setThemeMode, setAccent } =
    useSettingsStore();

  useEffect(() => {
    const unlisten = listen<string>("menu-action", (event) => {
      if (event.payload === "settings") togglePanel();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [togglePanel]);

  useEffect(() => {
    setOverlayActive(panelOpen);
  }, [panelOpen]);

  if (!panelOpen) return null;

  return (
    <div className="settings-backdrop" onClick={closePanel}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>Settings</span>
          <button className="icon-button" title="Close" onClick={closePanel}>
            ×
          </button>
        </div>

        <div className="settings-row">
          <span className="settings-label">Theme</span>
          <div className="theme-options">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                className={opt.id === themeMode ? "theme-option selected" : "theme-option"}
                onClick={() => setThemeMode(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <span className="settings-label">Accent</span>
          <div className="accent-swatches">
            {ACCENT_SWATCHES.map((swatch) => (
              <button
                key={swatch.id}
                className={swatch.id === accentId ? "accent-swatch selected" : "accent-swatch"}
                style={{ background: swatch.light }}
                title={swatch.label}
                onClick={() => setAccent(swatch.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
