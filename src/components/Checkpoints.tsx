import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTabStore } from "../store/tabs";
import { setOverlayActive, isInternalUrl } from "../lib/tabs";
import {
  deleteCheckpoint, listCheckpoints, restoreCheckpoint, saveCheckpoint,
  openCheckpoints, type Checkpoint,
} from "../lib/checkpoints";
import { Icon } from "./Icon";
import { hostOf } from "./SiteMark";
import "./Checkpoints.css";

function dateLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function Checkpoints() {
  const isPrivate = useTabStore((s) => s.isPrivate);
  const [open, setOpen] = useState(false);
  const [saveRequested, setSaveRequested] = useState(0);
  const close = useCallback(() => { setOpen(false); setSaveRequested(0); }, []);

  useEffect(() => {
    function show(event: Event) {
      if (useTabStore.getState().isPrivate) return;
      setOpen(true);
      if ((event as CustomEvent<{ save: boolean }>).detail.save) {
        setSaveRequested((n) => n + 1);
      }
    }
    window.addEventListener("twig:checkpoints", show);
    const unlisten = listen<string>("menu-action", ({ payload }) => {
      if (payload === "show-checkpoints" || payload === "save-checkpoint") {
        openCheckpoints(payload === "save-checkpoint");
      }
    });
    return () => {
      window.removeEventListener("twig:checkpoints", show);
      unlisten.then((fn) => fn());
    };
  }, []);

  return open && !isPrivate
    ? <CheckpointBrowser saveRequested={saveRequested} onClose={close} />
    : null;
}

function CheckpointBrowser({ saveRequested, onClose }: {
  saveRequested: number;
  onClose: () => void;
}) {
  const { tabs, groups, activeGroupId, tabStripVisible } = useTabStore();
  const space = groups.find((g) => g.id === activeGroupId);
  const currentTabs = tabs.filter((tab) => tab.groupId === activeGroupId);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [composing, setComposing] = useState(saveRequested > 0);
  const [name, setName] = useState(space?.name ?? "");
  const [note, setNote] = useState("");
  const [forking, setForking] = useState(false);
  const [forkName, setForkName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const forkRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const selected = checkpoints.find((entry) => entry.id === selectedId) ?? null;
  const visible = checkpoints.filter((entry) =>
    `${entry.name} ${entry.note} ${entry.spaceName}`.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement;
    dialogRef.current?.showModal();
    setOverlayActive(true, "checkpoints").catch((cause) => setError(String(cause)));
    return () => {
      mounted.current = false;
      setOverlayActive(false, "checkpoints").catch(() => {});
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entries = await listCheckpoints();
      if (!mounted.current) return;
      entries.sort((a, b) => b.createdAt - a.createdAt);
      setCheckpoints(entries);
      setSelectedId((id) => entries.some((entry) => entry.id === id) ? id : entries[0]?.id ?? null);
    } catch (cause) {
      if (mounted.current) setError(`Could not load checkpoints. ${String(cause)}`);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (saveRequested > 0 && !busyRef.current) setComposing(true);
  }, [saveRequested]);

  useEffect(() => {
    if (composing) nameRef.current?.focus();
  }, [composing]);

  useEffect(() => {
    if (forking) { forkRef.current?.focus(); forkRef.current?.select(); }
  }, [forking]);

  // Lock synchronously, before React renders, so rapid clicks cannot
  // create duplicate spaces or issue overlapping writes.
  async function perform(operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    try { await operation(); }
    catch (cause) { if (mounted.current) setError(String(cause)); }
    finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function beginSave() {
    setName(space?.name ?? "");
    setNote("");
    setComposing(true);
    setForking(false);
    setConfirmDelete(false);
    setError(null);
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    void perform(async () => {
      const entry = await saveCheckpoint(name.trim(), note.trim());
      if (!mounted.current) return;
      setCheckpoints((all) => [entry, ...all]);
      setSelectedId(entry.id);
      setQuery("");
      setComposing(false);
      setNotice("Checkpoint saved on this Mac.");
    });
  }

  function resume(fork?: string) {
    if (!selected) return;
    void perform(async () => {
      await restoreCheckpoint(selected.id, fork);
      onClose();
    });
  }

  return (
    <dialog
      ref={dialogRef}
      className="checkpoints"
      style={{ top: (tabStripVisible ? 38 : 0) + 46 }}
      aria-labelledby="checkpoints-title"
      aria-busy={busy || loading}
      onCancel={(event) => { event.preventDefault(); if (!busyRef.current) onClose(); }}
    >
      <header className="checkpoints-header">
        <div>
          <h1 id="checkpoints-title"><Icon name="history" size={20} /> Checkpoints</h1>
          <p>A place to return to. A starting point for something new.</p>
        </div>
        <div className="checkpoint-actions">
          <button className="checkpoint-button primary" disabled={busy || loading || !currentTabs.length} onClick={beginSave}>
            <Icon name="plus" size={14} /> Save current space
          </button>
          <button className="checkpoint-button icon-only" aria-label="Close checkpoints" title="Close (Esc)" disabled={busy} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      </header>

      {error && <div className="checkpoint-error" role="alert">
        <span>{error}</span>
        <button className="checkpoint-button" disabled={busy || loading} onClick={() => void load()}>Reload checkpoints</button>
      </div>}
      <div className="checkpoint-notice" role="status">{notice}</div>

      <div className="checkpoints-body">
        <aside className="checkpoint-timeline" aria-label="Saved checkpoints">
          <label className="checkpoint-search">
            <Icon name="search" size={15} />
            <input aria-label="Search checkpoints" placeholder="Find a checkpoint…" value={query} disabled={busy} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="checkpoint-entries">
            {loading ? <p className="checkpoint-muted">Loading checkpoints…</p> : visible.length === 0 ? (
              <p className="checkpoint-muted">{query ? "No matching checkpoints." : "Your saved moments will appear here."}</p>
            ) : visible.map((entry) => (
              <button
                key={entry.id}
                className={`checkpoint-entry${selectedId === entry.id && !composing ? " selected" : ""}`}
                aria-pressed={selectedId === entry.id && !composing}
                disabled={busy}
                onClick={() => {
                  setSelectedId(entry.id); setComposing(false); setForking(false);
                  setConfirmDelete(false); setError(null); setNotice("");
                }}
              >
                <time dateTime={new Date(entry.createdAt).toISOString()}>{dateLabel(entry.createdAt)}</time>
                <strong>{entry.name}</strong>
                <span>{entry.spaceName} · {entry.tabs.length} {entry.tabs.length === 1 ? "tab" : "tabs"}</span>
                {entry.parentId && <span className="checkpoint-lineage"><Icon name="fork" size={12} /> Continued from a checkpoint</span>}
              </button>
            ))}
          </div>
          <p className="checkpoint-local"><Icon name="lock" size={12} /> Saved on this Mac</p>
        </aside>

        <main className="checkpoint-detail">
          {composing ? (
            <form className="checkpoint-compose" onSubmit={save}>
              <h2>Keep your place</h2>
              <p>Save {currentTabs.length} {currentTabs.length === 1 ? "tab" : "tabs"} in <strong>{space?.name}</strong>, including their order, reading positions, and split view.</p>
              <label htmlFor="checkpoint-name">Checkpoint name</label>
              <input ref={nameRef} id="checkpoint-name" required maxLength={120} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} placeholder="Before exploring another approach" />
              <label htmlFor="checkpoint-note">A note for when you return <span>(optional)</span></label>
              <textarea id="checkpoint-note" rows={4} maxLength={2000} value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} placeholder="What were you looking into? What comes next?" />
              <p className="checkpoint-muted">Pages reopen from their saved addresses. Forms, sign-ins, and page content aren’t frozen in time.</p>
              <div className="checkpoint-actions">
                <button type="submit" className="checkpoint-button primary" disabled={busy || loading || !name.trim() || !currentTabs.length}>{busy ? "Saving…" : "Save checkpoint"}</button>
                <button type="button" className="checkpoint-button" disabled={busy} onClick={() => setComposing(false)}>Cancel</button>
              </div>
            </form>
          ) : selected ? (
            <>
              <div className="checkpoint-detail-heading">
                <h2>{selected.name}</h2>
                <p>{selected.spaceName} · {dateLabel(selected.createdAt)}</p>
                {selected.parentId && <p className="checkpoint-lineage"><Icon name="fork" size={14} /> From {checkpoints.find((entry) => entry.id === selected.parentId)?.name ?? "an earlier checkpoint"}</p>}
                {selected.note && <p className="checkpoint-note">{selected.note}</p>}
              </div>

              <ol className="checkpoint-tabs" aria-label="Tabs in this checkpoint">
                {selected.tabs.map((tab) => (
                  <li key={tab.id}>
                    <span className="checkpoint-site-mark" aria-hidden="true">{hostOf(tab.url).charAt(0).toUpperCase() || "T"}</span>
                    <span className="checkpoint-tab-text"><strong>{tab.title || "New tab"}</strong><span>{isInternalUrl(tab.url) ? "New tab" : hostOf(tab.url)}</span></span>
                    {tab.id === selected.activeId && <span className="checkpoint-tab-state">Active</span>}
                    {tab.id === selected.splitId && <span className="checkpoint-tab-state"><Icon name="split" size={12} /> Split</span>}
                  </li>
                ))}
              </ol>

              <div className="checkpoint-resume">
                <p>Resume in a separate space. Your current tabs stay where they are.</p>
                {forking ? (
                  <form onSubmit={(e) => { e.preventDefault(); if (forkName.trim()) resume(forkName.trim()); }}>
                    <label htmlFor="checkpoint-fork">Name your new direction</label>
                    <input ref={forkRef} id="checkpoint-fork" required maxLength={120} value={forkName} disabled={busy} onChange={(e) => setForkName(e.target.value)} />
                    <div className="checkpoint-actions">
                      <button type="submit" className="checkpoint-button primary" disabled={busy || !forkName.trim()}>{busy ? "Opening…" : "Create fork"}</button>
                      <button type="button" className="checkpoint-button" disabled={busy} onClick={() => setForking(false)}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <div className="checkpoint-actions">
                    <button className="checkpoint-button primary" disabled={busy} onClick={() => resume()}><Icon name="forward" size={14} /> {busy ? "Working…" : "Resume checkpoint"}</button>
                    <button className="checkpoint-button" disabled={busy} onClick={() => { setForkName(`${selected.name.slice(0, 110)} — fork`); setForking(true); setConfirmDelete(false); }}><Icon name="fork" size={14} /> Fork into a new space</button>
                  </div>
                )}
              </div>
              <div className="checkpoint-delete">
                {confirmDelete ? <>
                  <span>Delete this saved checkpoint? Open tabs are kept.</span>
                  <button className="checkpoint-button" disabled={busy} onClick={() => void perform(async () => {
                    await deleteCheckpoint(selected.id);
                    const remaining = checkpoints.filter((entry) => entry.id !== selected.id);
                    setCheckpoints(remaining); setSelectedId(remaining[0]?.id ?? null);
                    setConfirmDelete(false); setNotice("Checkpoint deleted. Open tabs were kept.");
                  })}>Delete checkpoint</button>
                  <button className="checkpoint-button" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep it</button>
                </> : <button className="checkpoint-text-button" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete checkpoint…</button>}
              </div>
            </>
          ) : (
            <div className="checkpoint-empty">
              <Icon name="history" size={32} />
              <h2>Leave yourself a way back.</h2>
              <p>Save a moment in your browsing. Return to the same tabs and reading positions, or take the research in a new direction.</p>
              <button className="checkpoint-button primary" disabled={busy || loading || !currentTabs.length} onClick={beginSave}>Save your first checkpoint</button>
              <p className="checkpoint-muted">You choose what to save. Private browsing is never included.</p>
            </div>
          )}
        </main>
      </div>
    </dialog>
  );
}
