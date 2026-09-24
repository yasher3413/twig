import { useEffect, useRef, useState } from "react";
import { useTabStore } from "../store/tabs";
import { useSnoozeStore } from "../store/snooze";
import { useChangeStore } from "../store/changes";
import { useStaleTabs } from "../lib/use-stale-tabs";
import { snoozePresets } from "../lib/snooze";
import { canSnooze, snoozeTab } from "../lib/snooze-actions";
import { setContentInset, setOverlayActive } from "../lib/tabs";
import { SiteMark, hostOf } from "./SiteMark";
import { Icon } from "./Icon";
import "./SweepPanel.css";

const PANEL_WIDTH = 380;
const NARROW = 880;

export function SweepPanel() {
  const open = useSnoozeStore((s) => s.sweepOpen);
  const isPrivate = useTabStore((s) => s.isPrivate);
  return open && !isPrivate ? <Sweep /> : null;
}

function Sweep() {
  const close = useSnoozeStore((s) => s.closeSweep);
  const days = useSnoozeStore((s) => s.sweepDays);
  const tabStripVisible = useTabStore((s) => s.tabStripVisible);
  const groups = useTabStore((s) => s.groups);
  const stale = useStaleTabs();
  const [unchecked, setUnchecked] = useState<Record<string, true>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const chosen = stale.filter((t) => !unchecked[t.id]);

  useEffect(() => {
    // One side panel at a time.
    useChangeStore.getState().close();
    headingRef.current?.focus();
    const onResize = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (narrow) {
      setOverlayActive(true, "sweep").catch(() => {});
      return () => { setOverlayActive(false, "sweep").catch(() => {}); };
    }
    setContentInset(PANEL_WIDTH).catch(() => {});
    return () => { setContentInset(0).catch(() => {}); };
  }, [narrow]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await action(); close(); } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }
  const archive = () => run(async () => {
    for (const tab of chosen) await useTabStore.getState().close(tab.id);
  });
  const snooze = () => run(async () => {
    const at = snoozePresets(new Date()).find((p) => p.id === "week")!.at;
    for (const tab of chosen) if (canSnooze(tab.id)) await snoozeTab(tab.id, at);
  });
  const lastUsed = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <aside className={narrow ? "sweep narrow" : "sweep"} style={{ top: tabStripVisible ? 84 : 46 }}
      aria-label="Untouched tabs"
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); close(); } }}>
      <header className="sweep-header">
        <div>
          <h2 ref={headingRef} tabIndex={-1}>Tabs you haven&apos;t touched</h2>
          <p>Untouched for {days} days or more. Archived tabs stay in Library → Closed.</p>
        </div>
        <button className="sweep-icon" aria-label="Close" title="Close (Esc)" onClick={close}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className="sweep-list">
        {stale.length === 0 && <p className="sweep-empty">Nothing untouched right now.</p>}
        {stale.map((tab) => (
          <label key={tab.id} className="sweep-row">
            <input type="checkbox" checked={!unchecked[tab.id]} onChange={(e) => setUnchecked((u) => {
              const next = { ...u };
              if (e.target.checked) delete next[tab.id]; else next[tab.id] = true;
              return next;
            })} />
            <SiteMark url={tab.url} size={16} />
            <span className="sweep-text">
              <span className="sweep-title">{tab.title || hostOf(tab.url)}</span>
              <span className="sweep-meta">{groups.find((g) => g.id === tab.groupId)?.name ?? "Space"} · last used {lastUsed(tab.lastUsedAt)}</span>
            </span>
          </label>
        ))}
      </div>
      {error && <p className="sweep-error" role="alert">{error}</p>}
      <footer className="sweep-footer">
        <button className="sweep-button primary" disabled={busy || chosen.length === 0} onClick={archive}>
          Archive {chosen.length} {chosen.length === 1 ? "tab" : "tabs"}
        </button>
        <button className="sweep-button" disabled={busy || chosen.length === 0} onClick={snooze}>Snooze to next week</button>
        <button className="sweep-button quiet" disabled={busy} onClick={() => useSnoozeStore.getState().dismiss(Date.now())}>Not now</button>
      </footer>
    </aside>
  );
}
