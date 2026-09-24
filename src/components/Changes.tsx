import { useEffect, useMemo, useRef, useState } from "react";
import { useTabStore } from "../store/tabs";
import { useChangeStore } from "../store/changes";
import { diffCopies, hostOf, hunks, shortDate, type Hunk, type PageChange } from "../lib/changes";
import { copiesOf, getRecallCopy } from "../lib/recall-db";
import { openRecall } from "../lib/recall";
import { setContentInset, setOverlayActive } from "../lib/tabs";
import { useMenuAction } from "../lib/menu";
import { Icon } from "./Icon";
import { useSnoozeStore } from "../store/snooze";
import "./Changes.css";

const PANEL_WIDTH = 380;
const NARROW = 880;

export function Changes() {
  const activeId = useTabStore((s) => s.activeId);
  const openFor = useChangeStore((s) => s.openFor);
  const change = useChangeStore((s) => (s.openFor ? s.byTab[s.openFor] : undefined));
  const close = useChangeStore((s) => s.close);

  useMenuAction(["show-changes"], () => {
    const id = useTabStore.getState().activeId;
    if (id) useChangeStore.getState().open(id);
  });
  // The panel is about the page in front of you; switching tabs ends it.
  useEffect(() => { if (openFor && openFor !== activeId) close(); }, [openFor, activeId, close]);

  return change && openFor === activeId ? <ChangesPanel key={`${openFor}:${change.capturedAt}`} change={change} onClose={close} /> : null;
}

function ChangesPanel({ change, onClose }: { change: PageChange; onClose: () => void }) {
  const tabStripVisible = useTabStore((s) => s.tabStripVisible);
  const mute = useChangeStore((s) => s.mute);
  const [compareId, setCompareId] = useState(change.baselineId);
  const [copies, setCopies] = useState<{ id: number; capturedAt: number }[]>([]);
  const [older, setOlder] = useState<{ body: string; capturedAt: number } | null | undefined>(undefined);
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const host = hostOf(change.url);

  useEffect(() => {
    const previous = document.activeElement;
    // One side panel at a time.
    useSnoozeStore.getState().closeSweep();
    headingRef.current?.focus();
    return () => {
      const chip = document.querySelector<HTMLElement>(".change-chip");
      (chip ?? (previous instanceof HTMLElement ? previous : null))?.focus();
    };
  }, []);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Beside the page when there's room for both; over it when there isn't.
  useEffect(() => {
    if (narrow) {
      setOverlayActive(true, "changes").catch(() => {});
      return () => { setOverlayActive(false, "changes").catch(() => {}); };
    }
    setContentInset(PANEL_WIDTH).catch(() => {});
    return () => { setContentInset(0).catch(() => {}); };
  }, [narrow]);

  useEffect(() => {
    let live = true;
    copiesOf(change.url)
      .then((rows) => { if (live) setCopies(rows.filter((r) => r.capturedAt < change.capturedAt)); })
      .catch(() => {});
    return () => { live = false; };
  }, [change.url, change.capturedAt]);

  useEffect(() => {
    let live = true;
    setOlder(undefined);
    getRecallCopy(compareId)
      .then((copy) => { if (live) setOlder(copy ? { body: copy.body, capturedAt: copy.capturedAt } : null); })
      .catch(() => { if (live) setOlder(null); });
    return () => { live = false; };
  }, [compareId]);

  const diff = useMemo(() => (older ? diffCopies(older.body, change.currentBody) : null), [older, change.currentBody]);
  const shown: Hunk[] = useMemo(() => (diff ? hunks(diff.passages) : []), [diff]);
  const now = Date.now();

  return (
    <aside
      className={narrow ? "changes narrow" : "changes"}
      style={{ top: tabStripVisible ? 84 : 46 }}
      aria-label="Changes to this page"
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
    >
      <header className="changes-header">
        <div>
          <h2 id="changes-heading" ref={headingRef} tabIndex={-1}>What changed since you read it</h2>
          <p className="changes-range">
            {older ? shortDate(older.capturedAt, now) : "…"} → {shortDate(change.capturedAt, now)}
          </p>
        </div>
        <button className="changes-icon" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>

      {diff && (
        <p className="changes-counts" aria-label={`${diff.added} added, ${diff.removed} removed, ${diff.edited} edited`}>
          <span className="count added">+{diff.added}</span>
          <span className="count removed">−{diff.removed}</span>
          <span className="count edited">~{diff.edited}</span>
        </p>
      )}

      <div className="changes-body">
        {older === null && <p className="changes-empty">This copy is no longer saved.</p>}
        {diff && shown.length === 0 && <p className="changes-empty">No differences in the text.</p>}
        {shown.map((hunk, i) =>
          hunk.kind === "gap" ? (
            <p key={i} className="change-gap">⋯ {hunk.count} unchanged {hunk.count === 1 ? "paragraph" : "paragraphs"}</p>
          ) : (
            <p key={i} className={`change-passage ${hunk.kind}`}>
              {hunk.kind === "added" && <span className="visually-hidden">Added: </span>}
              {hunk.kind === "removed" && <span className="visually-hidden">Removed: </span>}
              {hunk.kind === "edited" && hunk.words
                ? hunk.words.map((w, k) =>
                    w.kind === "added" ? <ins key={k}>{w.text}</ins> : w.kind === "removed" ? <del key={k}>{w.text}</del> : <span key={k}>{w.text}</span>)
                : hunk.text}
            </p>
          ),
        )}
      </div>

      <footer className="changes-footer">
        {copies.length > 1 && (
          <label className="changes-compare">
            <span>Compare with</span>
            <select aria-label="Compare with" value={compareId} onChange={(e) => setCompareId(Number(e.target.value))}>
              {copies.map((c) => (
                <option key={c.id} value={c.id}>{new Date(c.capturedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</option>
              ))}
            </select>
          </label>
        )}
        <div className="changes-actions">
          <button className="changes-button" onClick={() => { onClose(); openRecall(); }}>
            <Icon name="recall" size={13} /> Open in Recall
          </button>
          {host && (
            <button className="changes-button quiet" onClick={() => mute(host)}>
              Don&apos;t flag changes on {host}
            </button>
          )}
        </div>
      </footer>
    </aside>
  );
}
