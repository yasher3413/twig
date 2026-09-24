import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTabStore } from "../store/tabs";
import { setOverlayActive } from "../lib/tabs";
import { dateInputValue, localDayBounds, openRecall, openRecalledPage, passageFromSnippet, readingParts, snippetParts, type TextPart } from "../lib/recall";
import { deleteRecallCopy, deleteRecallUrl, getRecallCopy, nearbyRecall, recallSpaces, searchRecall, type RecallCopy, type RecallMatch } from "../lib/recall-db";
import { Icon } from "./Icon";
import { useMenuAction } from "../lib/menu";
import "./Recall.css";

function Highlighted({ parts }: { parts: TextPart[] }) {
  return <>{parts.map((part, i) => part.matched ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>)}</>;
}

function capturedDate(value: number): string {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function Recall() {
  const isPrivate = useTabStore((s) => s.isPrivate);
  const [request, setRequest] = useState<{ query: string } | null>(null);
  const [captureWarning, setCaptureWarning] = useState<string | null>(null);
  const close = useCallback(() => setRequest(null), []);
  useEffect(() => {
    function show(event: Event) {
      if (useTabStore.getState().isPrivate) return;
      setRequest({ query: (event as CustomEvent<{ query: string }>).detail?.query ?? "" });
    }
    function failed(event: Event) { setCaptureWarning(String((event as CustomEvent).detail)); }
    window.addEventListener("twig:recall", show);
    window.addEventListener("twig:recall-index-error", failed);
    return () => {
      window.removeEventListener("twig:recall", show);
      window.removeEventListener("twig:recall-index-error", failed);
    };
  }, []);

  useMenuAction(["show-recall"], () => openRecall());
  return request && !isPrivate ? <RecallBrowser initialQuery={request.query} captureWarning={captureWarning}
    dismissWarning={() => setCaptureWarning(null)} onClose={close} /> : null;
}

function RecallBrowser({ initialQuery, captureWarning, dismissWarning, onClose }: {
  initialQuery: string; captureWarning: string | null; dismissWarning: () => void; onClose: () => void;
}) {
  const tabStripVisible = useTabStore((s) => s.tabStripVisible);
  const [query, setQuery] = useState(initialQuery);
  const [spaceId, setSpaceId] = useState("");
  const [fromDay, setFromDay] = useState("");
  const [throughDay, setThroughDay] = useState("");
  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([]);
  const [results, setResults] = useState<RecallMatch[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [copy, setCopy] = useState<RecallCopy | null>(null);
  const [nearby, setNearby] = useState<RecallMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [deleting, setDeleting] = useState<"copy" | "url" | null>(null);
  const [notice, setNotice] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const readingRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const selectedResult = results.find((result) => result.id === selectedId);
  const matchedWords = selectedResult ? snippetParts(selectedResult.snippet).filter((part) => part.matched).map((part) => part.text).join(" ") : "";
  const bodyParts = useMemo(() => readingParts(copy?.body ?? "", matchedWords || query), [copy?.body, query, matchedWords]);

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement;
    dialogRef.current?.showModal();
    inputRef.current?.focus();
    setOverlayActive(true, "recall").catch((cause) => setError(String(cause)));
    const changed = () => setRevision((n) => n + 1);
    window.addEventListener("twig:recall-changed", changed);
    return () => {
      mounted.current = false;
      window.removeEventListener("twig:recall-changed", changed);
      setOverlayActive(false, "recall").catch(() => {});
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  useEffect(() => { setQuery(initialQuery); }, [initialQuery]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setDeleting(null);
    const timer = setTimeout(async () => {
      try {
        const range = localDayBounds(fromDay, throughDay);
        const [matches, knownSpaces] = await Promise.all([
          searchRecall({ query, spaceId: spaceId || undefined, ...range, limit: 100 }), recallSpaces(),
        ]);
        if (cancelled) return;
        setResults(matches); setSpaces(knownSpaces);
        setSelectedId((id) => matches.some((match) => match.id === id) ? id : matches[0]?.id ?? null);
      } catch (cause) {
        if (!cancelled) { setError(String(cause)); setResults([]); setSelectedId(null); }
      } finally { if (!cancelled) setLoading(false); }
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, spaceId, fromDay, throughDay, revision]);

  useEffect(() => {
    let cancelled = false;
    setCopy(null); setNearby([]); setDeleting(null); setDetailError(null);
    if (selectedId === null) { setReading(false); return; }
    setReading(true);
    Promise.all([getRecallCopy(selectedId), nearbyRecall(selectedId)])
      .then(([saved, context]) => {
        if (cancelled) return;
        setCopy(saved); setNearby(context);
        if (!saved) setDetailError("This saved copy is no longer available. Refresh the results to continue.");
      })
      .catch((cause) => { if (!cancelled) setDetailError(String(cause)); })
      .finally(() => { if (!cancelled) setReading(false); });
    return () => { cancelled = true; };
  }, [selectedId, detailRevision, revision]);

  useEffect(() => {
    readingRef.current?.scrollTo(0, 0);
    const firstMatch = readingRef.current?.querySelector("mark");
    if (firstMatch && readingRef.current) readingRef.current.scrollTop = Math.max(0, firstMatch.offsetTop - readingRef.current.clientHeight / 2);
    detailRef.current?.scrollTo(0, 0);
  }, [copy?.id, bodyParts]);

  async function perform(operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setDetailError(null); setNotice("");
    try { await operation(); }
    catch (cause) { if (mounted.current) setDetailError(String(cause)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  function chooseRange(days: number) {
    const today = new Date();
    const start = new Date(today); start.setDate(start.getDate() - days + 1);
    setFromDay(dateInputValue(start)); setThroughDay(dateInputValue(today));
  }

  return <dialog ref={dialogRef} className="recall" style={{ top: (tabStripVisible ? 38 : 0) + 46 }}
    aria-labelledby="recall-title" onCancel={(event) => { event.preventDefault(); if (!busyRef.current) onClose(); }}>
    <header className="recall-header">
      <div><h1 id="recall-title"><Icon name="recall" size={20} /> Recall</h1><p>Find the passage. Pick up the thought.</p></div>
      <button className="recall-button icon-only" aria-label="Close recall" title="Close (Esc)" disabled={busy} onClick={onClose}><Icon name="close" /></button>
    </header>
    <div className="recall-filters">
      <label className="recall-search"><Icon name="search" size={17} /><input ref={inputRef} aria-label="Search saved page text" maxLength={500} value={query} placeholder="Words you remember reading…" onChange={(e) => setQuery(e.target.value)} disabled={busy} /></label>
      <div className="recall-filter-row">
        <label>Space<select aria-label="Filter by space" value={spaceId} onChange={(e) => setSpaceId(e.target.value)} disabled={busy}><option value="">All spaces</option>{spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>
        <label>From<input type="date" aria-label="Captured from" value={fromDay} onChange={(e) => setFromDay(e.target.value)} disabled={busy} /></label>
        <label>Through<input type="date" aria-label="Captured through" value={throughDay} onChange={(e) => setThroughDay(e.target.value)} disabled={busy} /></label>
        <div className="recall-range-shortcuts"><button disabled={busy} onClick={() => chooseRange(1)}>Today</button><button disabled={busy} onClick={() => chooseRange(7)}>Last 7 days</button><button disabled={busy} onClick={() => { setFromDay(""); setThroughDay(""); setSpaceId(""); }}>All time</button></div>
      </div>
    </div>
    {captureWarning && <div className="recall-banner" role="status"><span>Some page text could not be saved. {captureWarning}</span><button className="recall-button" onClick={dismissWarning}>Dismiss</button></div>}
    {error && <div className="recall-banner" role="alert"><span>{error}</span><button className="recall-button" onClick={() => setRevision((n) => n + 1)}>Retry search</button></div>}
    <div className="recall-status" role="status">{notice}</div>
    <div className="recall-body">
      <aside className="recall-results" aria-label="Matching saved pages" aria-busy={loading}>
        <p className="recall-result-count" role="status">{loading ? "Searching saved text…" : results.length === 100 ? "First 100 matches · narrow the dates for more" : `${results.length} ${results.length === 1 ? "saved copy" : "saved copies"}`}</p>
        <div className="recall-result-list">
          {!loading && !results.length && <div className="recall-empty-results"><h2>{query || spaceId || fromDay || throughDay ? "No passages found" : "Your reading starts here"}</h2><p>{query || spaceId || fromDay || throughDay ? "Try fewer words, another space, or a wider date range." : "Text from the web pages you visit will appear here. You can search it even after closing the tabs."}</p></div>}
          {results.map((result) => <button className={`recall-result${selectedId === result.id ? " selected" : ""}`} key={result.id}
            aria-pressed={selectedId === result.id} disabled={busy || loading} onClick={() => { setSelectedId(result.id); setNotice(""); }}>
            <strong>{result.title || result.url}</strong><span className="recall-result-url">{result.url}</span>
            <span className="recall-snippet"><Highlighted parts={snippetParts(result.snippet)} /></span>
            <span className="recall-result-meta">{result.spaceName || "Unknown space"} · {capturedDate(result.capturedAt)}</span>
          </button>)}
        </div>
        <p className="recall-local"><Icon name="lock" size={12} /> Saved on this Mac · up to 2,000 copies</p>
      </aside>
      <main ref={detailRef} className="recall-detail" aria-busy={reading || busy}>
        {detailError && <div className="recall-detail-error" role="alert"><p>{detailError}</p><button className="recall-button" disabled={busy} onClick={() => { setDetailRevision((n) => n + 1); setRevision((n) => n + 1); }}>Reload saved copy</button></div>}
        {reading ? <p className="recall-muted">Loading saved copy…</p> : copy ? <>
          <div className="recall-copy-header">
            <h2>{copy.title || copy.url}</h2><p className="recall-source">{copy.url}</p>
            <p className="recall-muted">Saved {capturedDate(copy.capturedAt)} · {copy.spaceName || "Unknown space"}</p>
            <div className="recall-actions"><button className="recall-button primary" disabled={busy || loading} onClick={() => void perform(async () => {
              const passage = passageFromSnippet(selectedResult?.snippet ?? copy.snippet ?? "") || copy.body.slice(0, 2000);
              await openRecalledPage(copy.url, passage); onClose();
            })}><Icon name="forward" size={14} /> {query.trim() && selectedResult ? "Open live page at passage" : "Open live page"}</button>
            <span className="recall-muted">If the page has changed, your saved text is below.</span></div>
          </div>
          <section className="recall-reading" aria-label="Saved reading copy">
            <h3>Saved reading copy</h3><p className="recall-copy-note">Plain text captured on this date. Some pages may be incomplete.</p>
            <div ref={readingRef} className="recall-reading-text" tabIndex={0} aria-label="Saved page text"><Highlighted parts={bodyParts} /></div>
          </section>
          <section className="recall-context" aria-label="Nearby browsing activity"><h3>Captured around then</h3>
            <p>Other pages from the same space and browsing session, within 30 minutes.</p>
            {nearby.length ? <ul>{nearby.map((page) => <li key={page.id}><button disabled={busy} onClick={() => { setSelectedId(page.id); setNotice(""); }}><span>{page.title || page.url}</span><time dateTime={new Date(page.capturedAt).toISOString()}>{new Date(page.capturedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time></button></li>)}</ul> : <p className="recall-muted">No other captured pages around this moment.</p>}
          </section>
          <div className="recall-forget">{deleting ? <>
            <p>{deleting === "copy" ? "Delete this dated reading copy? Other copies and open tabs are kept." : "Forget every saved copy of this address? Open tabs are kept."}</p>
            <div className="recall-actions"><button className="recall-button" disabled={busy} onClick={() => void perform(async () => {
              if (deleting === "copy") await deleteRecallCopy(copy.id); else await deleteRecallUrl(copy.url);
              setSelectedId(null); setCopy(null); setDeleting(null); dismissWarning(); setRevision((n) => n + 1); setNotice("Saved text removed. Open tabs were kept.");
            })}>Confirm deletion</button><button className="recall-button" disabled={busy} onClick={() => setDeleting(null)}>Keep it</button></div>
          </> : <div className="recall-actions"><button className="recall-text-button" disabled={busy} onClick={() => setDeleting("copy")}>Delete this copy…</button><button className="recall-text-button" disabled={busy} onClick={() => setDeleting("url")}>Forget this page…</button></div>}</div>
        </> : !detailError && <div className="recall-empty-detail"><Icon name="recall" size={32} /><h2>A phrase is enough to begin.</h2><p>Search words from a page, then narrow by when and where you read it. Select a result to see its saved text and the pages captured around it.</p><p className="recall-muted">Older captures may have no recorded space. Private windows are never included.</p></div>}
      </main>
    </div>
  </dialog>;
}
