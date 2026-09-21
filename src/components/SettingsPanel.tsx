import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { clearSiteData, setOverlayActive } from "../lib/tabs";
import { clearHistory, historyCount } from "../lib/db";
import {
  ACCENT_SWATCHES,
  SEARCH_ENGINES,
  useSettingsStore,
  type ThemeMode,
} from "../store/settings";
import { Icon } from "./Icon";
import "./SettingsPanel.css";

const THEME_OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export function SettingsPanel() {
  const {
    panelOpen,
    togglePanel,
    closePanel,
    themeMode,
    accentId,
    searchEngineId,
    setThemeMode,
    setAccent,
    setSearchEngineId,
  } = useSettingsStore();
  const [pages, setPages] = useState(0);
  const [cleared, setCleared] = useState<string | null>(null);

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
    if (panelOpen) {
      setCleared(null);
      historyCount().then(setPages);
    }
  }, [panelOpen]);

  if (!panelOpen) return null;

  async function onClearHistory() {
    await clearHistory();
    setPages(0);
    setCleared("History cleared.");
  }

  async function onClearSiteData() {
    await clearSiteData();
    setCleared("Cookies and site data cleared — you'll be signed out of sites.");
  }

  return (
    <div className="settings-backdrop" onClick={closePanel}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>Settings</span>
          <button className="settings-close" title="Close" onClick={closePanel}>
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-group">
            <h3>Search</h3>
            <div className="settings-row">
              <span className="settings-label">Search engine</span>
              <div className="segmented">
                {SEARCH_ENGINES.map((engine) => (
                  <button
                    key={engine.id}
                    className={engine.id === searchEngineId ? "segment selected" : "segment"}
                    onClick={() => setSearchEngineId(engine.id)}
                  >
                    {engine.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="settings-group">
            <h3>Appearance</h3>
            <div className="settings-row">
              <span className="settings-label">Theme</span>
              <div className="segmented">
                {THEME_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    className={opt.id === themeMode ? "segment selected" : "segment"}
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
          </section>

          <section className="settings-group">
            <h3>Memory</h3>
            <p className="settings-help">
              Tabs you haven&apos;t looked at in 10 minutes go to sleep, and only 5 stay awake at
              once. Sleeping tabs give back their memory and wake up where you left them.
            </p>
          </section>

          <section className="settings-group">
            <h3>Data</h3>
            <p className="settings-help">
              Everything twig saves stays on this machine. There&apos;s no account and nothing is
              synced anywhere.
            </p>
            <div className="settings-row">
              <span className="settings-label">
                History
                <span className="settings-sub">
                  {pages.toLocaleString()} {pages === 1 ? "page" : "pages"}
                </span>
              </span>
              <button className="settings-button" onClick={onClearHistory} disabled={pages === 0}>
                Clear history
              </button>
            </div>
            <div className="settings-row">
              <span className="settings-label">
                Cookies and site data
                <span className="settings-sub">Keeps you signed in to sites</span>
              </span>
              <button className="settings-button" onClick={onClearSiteData}>
                Clear site data
              </button>
            </div>
            {cleared && <p className="settings-done">{cleared}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
