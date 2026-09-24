import { useEffect, useState } from "react";
import { clearSiteData, memoryStats, setOverlayActive, type MemoryStats } from "../lib/tabs";
import { clearHistory, historyCount } from "../lib/db";
import {
  ACCENT_SWATCHES,
  SEARCH_ENGINES,
  useSettingsStore,
  type ThemeMode,
} from "../store/settings";
import { Icon } from "./Icon";
import { useTabStore } from "../store/tabs";
import { recallCount } from "../lib/recall-db";
import { useMenuAction } from "../lib/menu";
import "./SettingsPanel.css";

const THEME_OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function formatMb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  return `${Math.round(kb / 1024)} MB`;
}

export function SettingsPanel() {
  const isPrivate = useTabStore((s) => s.isPrivate);
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
  const [copies, setCopies] = useState(0);
  const [dataError, setDataError] = useState<string | null>(null);
  const [cleared, setCleared] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryStats | null>(null);

  useMenuAction(["settings"], togglePanel);

  useEffect(() => {
    setOverlayActive(panelOpen, "settings");
    if (!panelOpen) return;
    setCleared(null);
    setDataError(null);
    if (!isPrivate) {
      Promise.all([historyCount(), recallCount()]).then(([history, saved]) => {
        setPages(history); setCopies(saved);
      }).catch((cause) => setDataError(String(cause)));
    }

    // Shelling out to ps for every sample, so poll gently.
    memoryStats().then(setMemory);
    const timer = setInterval(() => memoryStats().then(setMemory), 2000);
    return () => clearInterval(timer);
  }, [panelOpen, isPrivate]);

  if (!panelOpen) return null;

  async function onClearHistory() {
    if (isPrivate) return;
    try {
      await clearHistory();
      setPages(0); setCopies(0); setDataError(null);
      setCleared("History and saved reading copies cleared.");
    } catch (cause) { setDataError(`Could not clear all history. ${String(cause)}`); }
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
            <div className="ledger">
              <div className="ledger-cell">
                <span className="ledger-value">{formatMb(memory?.footprintKb ?? 0)}</span>
                <span className="ledger-label">in use</span>
              </div>
              <div className="ledger-cell">
                <span className="ledger-value">{memory?.awakeTabs ?? 0}</span>
                <span className="ledger-label">awake</span>
              </div>
              <div className="ledger-cell">
                <span className="ledger-value">{memory?.sleepingTabs ?? 0}</span>
                <span className="ledger-label">asleep</span>
              </div>
              <div className="ledger-cell accent">
                <span className="ledger-value">~{formatMb(memory?.estimatedSavedKb ?? 0)}</span>
                <span className="ledger-label">not spent</span>
              </div>
            </div>
            <p className="settings-help">
              Tabs you haven&apos;t looked at in 10 minutes go to sleep, and only 5 stay awake at
              once. Sleeping tabs hand back their memory and wake where you left them — though a
              tab that&apos;s playing something, or holding text you haven&apos;t sent, is left
              alone. &ldquo;Not spent&rdquo; estimates what the sleeping ones would cost at the
              current average.
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
                  {isPrivate ? "Manage history in a regular window" : `${pages.toLocaleString()} pages · ${copies.toLocaleString()} saved copies`}
                </span>
              </span>
              <button className="settings-button" onClick={onClearHistory} disabled={isPrivate || (pages === 0 && copies === 0)}>
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
            {dataError && <p className="settings-help" role="alert">{dataError}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
