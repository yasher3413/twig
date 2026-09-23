import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTabStore } from "../store/tabs";
import { setOverlayActive } from "../lib/tabs";
import {
  captureResearchExcerpt, deleteResearchPackage, draftFromPackage, draftFromPages,
  exportResearchPackage, listResearchPackages, moveDraftPage, openResearchPackage,
  openResearchPackages, packageFromDraft, parseResearchPackage, saveResearchPackage,
  type DraftPage, type ResearchDraft, type ResearchExcerpt, type ResearchPackage,
  type ResearchSource, type SavedResearchPackage,
} from "../lib/research";
import { Icon } from "./Icon";
import "./ResearchPackages.css";

interface Request { source?: ResearchSource; excerpt?: ResearchExcerpt | null }

export function ResearchPackages() {
  const [request, setRequest] = useState<Request | null>(null);
  const visible = useRef(false);
  const isPrivate = useTabStore((s) => s.isPrivate);
  const close = useCallback(() => { visible.current = false; setRequest(null); }, []);

  useEffect(() => {
    function show(event: Event) {
      if (useTabStore.getState().isPrivate || visible.current) return;
      visible.current = true;
      setRequest((event as CustomEvent<Request>).detail ?? {});
    }
    window.addEventListener("twig:research", show);
    const unlisten = listen<string>("menu-action", ({ payload }) => {
      if (payload === "show-research-packages") void openResearchPackages();
      if (payload === "package-current-space") void openResearchPackages("current");
    });
    return () => { window.removeEventListener("twig:research", show); unlisten.then((fn) => fn()); };
  }, []);

  return request && !isPrivate ? <PackageBrowser request={request} onClose={close} /> : null;
}

function sourceDraft(source: ResearchSource, excerpt?: ResearchExcerpt | null): ResearchDraft {
  if (source !== "current") {
    const draft = draftFromPages(source.name, source.tabs, source.createdAt);
    return { ...draft, description: source.note, sourceCheckpoint: { name: source.name, createdAt: source.createdAt } };
  }
  const store = useTabStore.getState();
  return draftFromPages(store.groups.find((g) => g.id === store.activeGroupId)?.name ?? "Research",
    store.tabs.filter((tab) => tab.groupId === store.activeGroupId), Date.now(), excerpt);
}

function PackageBrowser({ request, onClose }: { request: Request; onClose: () => void }) {
  const tabStripVisible = useTabStore((s) => s.tabStripVisible);
  const [saved, setSaved] = useState<SavedResearchPackage[]>([]);
  const [draft, setDraft] = useState<ResearchDraft | null>(() => request.source ? sourceDraft(request.source, request.excerpt) : null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [includeSource, setIncludeSource] = useState(false);
  const [editing, setEditing] = useState(!!request.source);
  const [dirty, setDirty] = useState(!!request.source);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const workbenchRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const packageValue = draft ? packageFromDraft(draft, includeSource) : null;
  const canUse = !!packageValue?.title && !!packageValue.pages.length && packageValue.pages.length <= 200;

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    dialogRef.current?.showModal();
    setOverlayActive(true, "research").catch((cause) => setError(String(cause)));
    return () => {
      mounted.current = false;
      setOverlayActive(false, "research").catch(() => {});
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const load = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setLoading(true);
    setError(null);
    try { const entries = await listResearchPackages(); if (mounted.current) setSaved(entries); }
    catch (cause) { if (mounted.current) setError(`Could not load your packages. ${String(cause)}`); }
    finally {
      busyRef.current = false;
      if (mounted.current) { setLoading(false); setBusy(false); }
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { workbenchRef.current?.scrollTo(0, 0); }, [editing]);

  async function perform(operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice("");
    try { await operation(); }
    catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  function leave(action: () => void) {
    if (busyRef.current) return;
    if (dirty) setPending(() => action);
    else action();
  }

  function setDocument(next: ResearchDraft, id: string | null, edit: boolean, changed: boolean) {
    workbenchRef.current?.scrollTo(0, 0);
    setDraft(next); setSavedId(id); setEditing(edit); setDirty(changed);
    setIncludeSource(!!next.sourceCheckpoint && !edit); setDeleting(false); setError(null); setNotice("");
  }

  function update(next: ResearchDraft) { setDraft(next); setDirty(true); setNotice(""); }
  function updatePage(key: string, patch: Partial<DraftPage>) {
    if (draft) update({ ...draft, pages: draft.pages.map((page) => page.key === key ? { ...page, ...patch } : page) });
  }

  async function persist(): Promise<ResearchPackage> {
    if (!packageValue || !canUse) throw new Error("Name the package and include between 1 and 200 pages.");
    const entry = await saveResearchPackage(packageValue, savedId);
    setSaved((all) => [entry, ...all.filter((item) => item.id !== entry.id)]);
    setSavedId(entry.id); setDirty(false);
    return entry.package;
  }

  function startCurrent() {
    leave(() => void perform(async () => {
      const excerpt = await captureResearchExcerpt().catch(() => null);
      setDocument(sourceDraft("current", excerpt), null, true, true);
    }));
  }

  function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    leave(() => void perform(async () => {
      if (file.size > 2 * 1024 * 1024) throw new Error("This package is larger than 2 MB. Choose a smaller .twig file.");
      const value = await parseResearchPackage(await file.text());
      setDocument(draftFromPackage(value), null, false, true);
      setNotice("Package preview loaded. Review the links and excerpts before opening or saving.");
    }));
  }

  return <dialog ref={dialogRef} className="research" style={{ top: (tabStripVisible ? 38 : 0) + 46 }}
    aria-labelledby="research-title" aria-busy={busy || loading}
    onCancel={(event) => { event.preventDefault(); leave(onClose); }}>
    <header className="research-header">
      <div><h1 id="research-title"><Icon name="package" size={20} /> Research packages</h1><p>Give your research somewhere to go.</p></div>
      <div className="research-actions">
        <button className="research-button" disabled={busy} onClick={() => fileRef.current?.click()}><Icon name="up" size={14} /> Import .twig</button>
        <button className="research-button primary" disabled={busy} onClick={startCurrent}><Icon name="plus" size={14} /> Use current space</button>
        <button className="research-button icon-only" aria-label="Close research packages" disabled={busy} onClick={() => leave(onClose)}><Icon name="close" /></button>
      </div>
      <input ref={fileRef} type="file" accept=".twig,application/json" hidden aria-label="Import research package file" onChange={importFile} />
    </header>

    {pending && <div className="research-banner" role="alert">
      <span>Discard unsaved package changes?</span>
      <button className="research-button" onClick={() => { const action = pending; setPending(null); setDirty(false); action(); }}>Discard changes</button>
      <button className="research-button primary" onClick={() => setPending(null)}>Keep editing</button>
    </div>}
    {error && <div className="research-banner" role="alert"><span>{error}</span><button className="research-button" disabled={busy || loading} onClick={() => void load()}>Reload library</button></div>}
    <div className="research-status" role="status">{notice}</div>

    <div className="research-body">
      <aside className="research-library" aria-label="Saved research packages">
        <label className="research-search"><Icon name="search" size={14} /><input aria-label="Search packages" value={query} placeholder="Find a package…" onChange={(e) => setQuery(e.target.value)} /></label>
        <div className="research-saved-list">
          {loading ? <p className="research-muted">Loading packages…</p> : saved.filter((entry) => `${entry.package.title} ${entry.package.description}`.toLowerCase().includes(query.toLowerCase())).map((entry) =>
            <button key={entry.id} className={`research-saved${entry.id === savedId ? " selected" : ""}`} aria-pressed={entry.id === savedId} disabled={busy}
              onClick={() => leave(() => setDocument(draftFromPackage(entry.package), entry.id, false, false))}>
              <strong>{entry.package.title}</strong><span>{entry.package.pages.length} {entry.package.pages.length === 1 ? "page" : "pages"} · {new Date(entry.savedAt).toLocaleDateString()}</span>
            </button>)}
          {!loading && saved.length === 0 && <p className="research-muted">Save a package to keep its notes and excerpts here.</p>}
          {!loading && saved.length > 0 && !saved.some((entry) => `${entry.package.title} ${entry.package.description}`.toLowerCase().includes(query.toLowerCase())) && <p className="research-muted">No matching packages.</p>}
        </div>
        <p className="research-local"><Icon name="lock" size={12} /> Your library stays on this Mac</p>
      </aside>

      <main ref={workbenchRef} className="research-workbench">
        {!draft || !packageValue ? <div className="research-empty">
          <Icon name="package" size={32} /><h2>Share the thinking behind the tabs.</h2>
          <p>Choose your sources, put them in order, and add the passages and notes that matter. Send a .twig package to continue in Twig, or a readable document anyone can open.</p>
          <button className="research-button primary" disabled={busy} onClick={startCurrent}>Package this space</button>
          <p className="research-muted">You can also start from a saved checkpoint.</p>
        </div> : <>
          <div className="research-document-bar">
            <div className="research-tabs" aria-label="Package view">
              <button className={editing ? "active" : ""} aria-pressed={editing} disabled={busy} onClick={() => setEditing(true)}>Edit package</button>
              <button className={!editing ? "active" : ""} aria-pressed={!editing} disabled={busy} onClick={() => setEditing(false)}>Preview & share</button>
            </div>
            <span className="research-muted">{packageValue.pages.length} included{dirty ? " · Unsaved changes" : " · Saved"}</span>
          </div>

          {editing ? <div className="research-editor">
            <label htmlFor="research-name">Package title</label>
            <input id="research-name" maxLength={120} value={draft.title} disabled={busy} onChange={(e) => update({ ...draft, title: e.target.value })} placeholder="What is this research about?" />
            <label htmlFor="research-description">Context for the reader</label>
            <textarea id="research-description" rows={3} maxLength={4000} value={draft.description} disabled={busy} onChange={(e) => update({ ...draft, description: e.target.value })} placeholder="What were you trying to understand? Where should they start?" />
            <div className="research-pages-heading"><h2>Build the reading order</h2><p>Include the useful pages. Move them into order, then add your notes and excerpts.</p></div>
            {!draft.pages.length && <p className="research-muted">This source has no shareable web pages. Open an HTTP or HTTPS page, then choose “Use current space”.</p>}
            {draft.pages.map((page, index) => <section className={`research-page-editor${page.included ? "" : " excluded"}`} key={page.key}>
              <div className="research-page-heading">
                <label className="research-checkbox"><input type="checkbox" checked={page.included} disabled={busy} onChange={(e) => updatePage(page.key, { included: e.target.checked })} /><span>Include page {index + 1}</span></label>
                <div className="research-actions"><button className="research-button icon-only" aria-label={`Move page ${index + 1} up`} disabled={busy || index === 0} onClick={() => update({ ...draft, pages: moveDraftPage(draft.pages, page.key, -1) })}><Icon name="up" size={14} /></button><button className="research-button icon-only" aria-label={`Move page ${index + 1} down`} disabled={busy || index === draft.pages.length - 1} onClick={() => update({ ...draft, pages: moveDraftPage(draft.pages, page.key, 1) })}><Icon name="down" size={14} /></button></div>
              </div>
              <label htmlFor={`page-title-${page.key}`}>Page title</label><input id={`page-title-${page.key}`} value={page.title} maxLength={500} disabled={busy || !page.included} onChange={(e) => updatePage(page.key, { title: e.target.value })} />
              <label htmlFor={`page-url-${page.key}`}>Source address</label><input id={`page-url-${page.key}`} type="url" value={page.url} maxLength={8192} disabled={busy || !page.included} onChange={(e) => updatePage(page.key, { url: e.target.value })} />
              {page.included && <>
                <label htmlFor={`page-note-${page.key}`}>Why this page matters <span>(optional)</span></label><textarea id={`page-note-${page.key}`} rows={2} maxLength={4000} value={page.note} disabled={busy} onChange={(e) => updatePage(page.key, { note: e.target.value })} />
                {page.excerpts.map((text, excerptIndex) => <div className="research-excerpt-editor" key={excerptIndex}>
                  <label htmlFor={`excerpt-${page.key}-${excerptIndex}`}>Excerpt {excerptIndex + 1}</label>
                  <textarea id={`excerpt-${page.key}-${excerptIndex}`} rows={3} maxLength={8000} value={text} disabled={busy} onChange={(e) => updatePage(page.key, { excerpts: page.excerpts.map((existing, i) => i === excerptIndex ? e.target.value : existing) })} />
                  <button className="research-text-button" disabled={busy} onClick={() => updatePage(page.key, { excerpts: page.excerpts.filter((_, i) => i !== excerptIndex) })}>Remove excerpt {excerptIndex + 1}</button>
                </div>)}
                <button className="research-text-button" disabled={busy || page.excerpts.length >= 20} onClick={() => updatePage(page.key, { excerpts: [...page.excerpts, ""] })}>Add an excerpt</button>
              </>}
            </section>)}
            {draft.sourceCheckpoint && <label className="research-checkbox research-provenance"><input type="checkbox" checked={includeSource} disabled={busy} onChange={(e) => { setIncludeSource(e.target.checked); setDirty(true); }} /><span>Include checkpoint name and date: {draft.sourceCheckpoint.name}</span></label>}
          </div> : <PackagePreview value={packageValue} />}

          <footer className="research-footer">
            {editing ? <div className="research-actions">
              <button className="research-button primary" disabled={busy || !canUse} onClick={() => setEditing(false)}>Preview package <Icon name="forward" size={14} /></button>
              <button className="research-button" disabled={busy || !canUse} onClick={() => void perform(async () => { await persist(); setNotice("Package saved on this Mac."); })}>Save locally</button>
            </div> : <>
              <p>Review the full addresses and excerpts. Everything shown here is included in the exported file.</p>
              <div className="research-actions">
                <button className="research-button primary" disabled={busy || !canUse} onClick={() => void perform(async () => { const value = await persist(); await openResearchPackage(value); onClose(); })}>Open in a new space</button>
                <button className="research-button" disabled={busy || !canUse} onClick={() => void perform(async () => { await persist(); setNotice("Package saved on this Mac."); })}>Save locally</button>
              </div>
              <div className="research-exports"><span>Export to Downloads</span><div className="research-actions">{([['twig', '.twig package'], ['markdown', 'Markdown'], ['html', 'HTML document']] as const).map(([format, label]) =>
                <button key={format} className="research-button" disabled={busy || !canUse} onClick={() => void perform(async () => { const value = await persist(); const path = await exportResearchPackage(value, format); setNotice(`Saved to ${path}`); })}><Icon name="down" size={14} /> {label}</button>)}</div></div>
            </>}
            {savedId && <div className="research-delete">{deleting ? <>
              <span>Remove this package from your library? Exported files and open tabs stay available.</span>
              <button className="research-button" disabled={busy} onClick={() => void perform(async () => {
                await deleteResearchPackage(savedId); setSaved((all) => all.filter((entry) => entry.id !== savedId));
                setDraft(null); setSavedId(null); setDirty(false); setDeleting(false); setNotice("Package removed from your library.");
              })}>Remove package</button><button className="research-button" disabled={busy} onClick={() => setDeleting(false)}>Keep it</button>
            </> : <button className="research-text-button" disabled={busy} onClick={() => setDeleting(true)}>Remove from library…</button>}</div>}
          </footer>
        </>}
      </main>
    </div>
  </dialog>;
}

function PackagePreview({ value }: { value: ResearchPackage }) {
  return <article className="research-preview" aria-label="Package preview">
    <h2>{value.title || "Untitled package"}</h2>
    <p className="research-preview-meta">{value.pages.length} {value.pages.length === 1 ? "source" : "sources"} · {new Date(value.createdAt).toLocaleDateString()}</p>
    {value.description && <p className="research-paragraph">{value.description}</p>}
    {value.sourceCheckpoint && <p className="research-muted">From checkpoint “{value.sourceCheckpoint.name}” · {new Date(value.sourceCheckpoint.createdAt).toLocaleDateString()}</p>}
    <ol className="research-preview-pages">{value.pages.map((page, index) => <li key={index}>
      <h3>{page.title || page.url}</h3><p className="research-source-url">{page.url}</p>
      <p className="research-muted">Captured {new Date(page.capturedAt).toLocaleDateString()}</p>
      {page.note && <p className="research-paragraph">{page.note}</p>}
      {page.excerpts.map((text, i) => <blockquote key={i}>{text}</blockquote>)}
    </li>)}</ol>
  </article>;
}
