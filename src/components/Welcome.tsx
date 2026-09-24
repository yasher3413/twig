import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTabStore } from "../store/tabs";
import {
  ACCENT_SWATCHES,
  MEMORY_STYLES,
  SEARCH_ENGINES,
  useSettingsStore,
  type ThemeMode,
} from "../store/settings";
import { setOverlayActive } from "../lib/tabs";
import { importBookmarks } from "../lib/db";
import { dispatchMenuAction, useMenuAction } from "../lib/menu";
import {
  RESERVED,
  canonAccel,
  detectBrowsers,
  displayAccel,
  getKeymap,
  greeting,
  hasFinishedWelcome,
  markWelcomeDone,
  readBrowserBookmarks,
  recordKey,
  setKeymap,
  suspendShortcuts,
  type Binding,
  type FoundBrowser,
  type WelcomeStep,
} from "../lib/onboarding";
import { Icon } from "./Icon";
import "./Welcome.css";

const STEPS: { id: WelcomeStep; name: string }[] = [
  { id: "welcome", name: "Welcome" },
  { id: "you", name: "You" },
  { id: "look", name: "Look" },
  { id: "tour", name: "How it works" },
  { id: "keys", name: "Shortcuts" },
  { id: "ready", name: "Ready" },
];

const TOUR = ["sleep", "palette", "recall", "spaces"] as const;
type TourStop = (typeof TOUR)[number];

// ---------------------------------------------------------------------
// Shell: decides whether the welcome is showing at all.
// ---------------------------------------------------------------------

export function Welcome() {
  const isPrivate = useTabStore((s) => s.isPrivate);
  const ready = useTabStore((s) => s.ready);
  const [open, setOpen] = useState(false);
  const [startAt, setStartAt] = useState<WelcomeStep>("welcome");

  // First launch only, and never in a private window - that's someone
  // who has already set twig up and wants to be left alone.
  useEffect(() => {
    if (ready && !isPrivate && !hasFinishedWelcome()) setOpen(true);
  }, [ready, isPrivate]);

  useEffect(() => {
    function show(event: Event) {
      setStartAt((event as CustomEvent<{ step: WelcomeStep }>).detail?.step ?? "welcome");
      setOpen(true);
    }
    window.addEventListener("twig:welcome", show);
    return () => window.removeEventListener("twig:welcome", show);
  }, []);

  useMenuAction(["show-welcome"], () => {
    setStartAt("welcome");
    setOpen(true);
  });

  useEffect(() => {
    setOverlayActive(open, "welcome");
  }, [open]);

  if (!open || isPrivate) return null;

  return (
    <WelcomeFlow
      startAt={startAt}
      onFinish={(focusAddress) => {
        markWelcomeDone();
        setOpen(false);
        if (focusAddress) requestAnimationFrame(() => dispatchMenuAction("focus-address"));
      }}
    />
  );
}

// ---------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------

function WelcomeFlow({ startAt, onFinish }: { startAt: WelcomeStep; onFinish: (focusAddress: boolean) => void }) {
  const [stepIndex, setStepIndex] = useState(() => STEPS.findIndex((s) => s.id === startAt));
  const [tourIndex, setTourIndex] = useState(0);
  const [imported, setImported] = useState<number | null>(null);
  const [changedKeys, setChangedKeys] = useState(0);
  const [triedPalette, setTriedPalette] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const step = STEPS[stepIndex].id;
  const tourStop = TOUR[tourIndex];

  // Move focus to each new step's heading, so the step is announced and
  // Tab starts from the top of it rather than from a button that vanished.
  useEffect(() => {
    headingRef.current?.focus();
  }, [stepIndex, tourIndex]);

  // The one bit of the tour you do rather than read.
  useMenuAction(["command-palette"], () => {
    if (step === "tour" && tourStop === "palette") setTriedPalette(true);
  });

  const next = useCallback(() => {
    if (step === "tour" && tourIndex < TOUR.length - 1) {
      setTourIndex((i) => i + 1);
      return;
    }
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  }, [step, tourIndex]);

  const back = useCallback(() => {
    if (step === "tour" && tourIndex > 0) {
      setTourIndex((i) => i - 1);
      return;
    }
    setStepIndex((i) => {
      const target = Math.max(i - 1, 0);
      if (STEPS[target].id === "tour") setTourIndex(TOUR.length - 1);
      return target;
    });
  }, [step, tourIndex]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing = (e.target as HTMLElement)?.closest?.("input, [data-recording]");
      if (e.key === "Escape" && !typing) {
        e.preventDefault();
        onFinish(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onFinish]);

  const last = step === "ready";
  const rootRef = useRef<HTMLDivElement>(null);

  // aria-modal alone doesn't stop Tab from walking out into the toolbar
  // behind, or a screen reader from listing those controls as if they
  // were part of the dialog. Everything that was on screen when the
  // welcome opened goes inert until it closes. Only what already existed
  // is touched: the command palette the tour asks you to open is created
  // afterwards and stays usable on top.
  useEffect(() => {
    const me = rootRef.current;
    const host = me?.parentElement;
    if (!me || !host) return;
    const muted = [...host.children].filter((el) => el !== me && !el.hasAttribute("inert")) as HTMLElement[];
    for (const el of muted) el.inert = true;
    return () => {
      for (const el of muted) el.inert = false;
    };
  }, []);

  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-heading" ref={rootRef}>
      <div className="welcome-side">
        <header className="welcome-top">
          <Branch reached={stepIndex} total={STEPS.length} />
          <span className="welcome-count">
            {STEPS[stepIndex].name}
            <span aria-hidden="true"> · </span>
            {stepIndex + 1} of {STEPS.length}
          </span>
        </header>

        <div className="welcome-body" key={`${step}-${tourIndex}`}>
          {step === "welcome" && <StepWelcome headingRef={headingRef} />}
          {step === "you" && <StepYou headingRef={headingRef} imported={imported} onImported={setImported} />}
          {step === "look" && <StepLook headingRef={headingRef} />}
          {step === "tour" && <StepTour headingRef={headingRef} stop={tourStop} tried={triedPalette} />}
          {step === "keys" && <StepKeysIntro headingRef={headingRef} changed={changedKeys} />}
          {step === "ready" && (
            <StepReady headingRef={headingRef} imported={imported} changedKeys={changedKeys} />
          )}
        </div>

        <footer className="welcome-nav">
          {stepIndex === 0 ? (
            <button className="welcome-quiet" onClick={() => onFinish(false)}>
              Skip setup
            </button>
          ) : (
            <button className="welcome-quiet" onClick={back}>
              <Icon name="back" size={14} /> Back
            </button>
          )}

          {step === "tour" && (
            <div className="welcome-dots" aria-label={`Part ${tourIndex + 1} of ${TOUR.length}`}>
              {TOUR.map((t, i) => (
                <span key={t} className={i === tourIndex ? "on" : i < tourIndex ? "done" : ""} />
              ))}
            </div>
          )}

          <button
            className="welcome-primary"
            onClick={last ? () => onFinish(true) : next}
            autoFocus={stepIndex === 0}
          >
            {step === "welcome" ? "Get started" : last ? "Start browsing" : "Continue"}
            {!last && <Icon name="forward" size={14} />}
          </button>
        </footer>
      </div>

      <div className={`welcome-stage step-${step}`} aria-hidden={step !== "keys"}>
        {step === "welcome" && <StageSleepingTabs awake={3} total={14} caption />}
        {step === "you" && <StageYou imported={imported} />}
        {step === "look" && <StageMiniWindow />}
        {step === "tour" && tourStop === "sleep" && <StageSleepingTabs total={10} />}
        {step === "tour" && tourStop === "palette" && <StagePalette tried={triedPalette} />}
        {step === "tour" && tourStop === "recall" && <StageRecall />}
        {step === "tour" && tourStop === "spaces" && <StageSpaces />}
        {step === "keys" && <KeyEditor onChangedCount={setChangedKeys} />}
        {step === "ready" && <StageMiniWindow greet />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Progress, drawn as a twig: a leaf opens at each step you've passed.
// ---------------------------------------------------------------------

function Branch({ reached, total }: { reached: number; total: number }) {
  const width = 232;
  const nodes = Array.from({ length: total }, (_, i) => 10 + (i * (width - 20)) / (total - 1));
  return (
    <svg className="branch" width={width} height="44" viewBox={`0 0 ${width} 44`} aria-hidden="true">
      <path className="branch-stem" d={`M2 26 C ${width * 0.3} 21, ${width * 0.6} 30, ${width - 2} 22`} />
      {nodes.map((x, i) => {
        const up = i % 2 === 0;
        const y = 26 - (x / width) * 3.5;
        const grown = i < reached;
        const current = i === reached;
        return (
          <g key={i} transform={`translate(${x} ${y})`}>
            <path
              className={grown ? "leaf grown" : "leaf"}
              d={up ? "M0 0 C -3 -9, 6 -17, 13 -17 C 12 -9, 6 -3, 0 0 Z" : "M0 0 C -3 9, 6 17, 13 17 C 12 9, 6 3, 0 0 Z"}
            />
            <circle className={current ? "bud current" : grown ? "bud grown" : "bud"} r={current ? 4 : 2.8} />
          </g>
        );
      })}
    </svg>
  );
}

type HeadingRef = { headingRef: React.RefObject<HTMLHeadingElement | null> };

function Heading({ headingRef, children }: HeadingRef & { children: React.ReactNode }) {
  return (
    <h1 id="welcome-heading" ref={headingRef} tabIndex={-1}>
      {children}
    </h1>
  );
}

// ---------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------

function StepWelcome({ headingRef }: HeadingRef) {
  return (
    <>
      <p className="welcome-mark">twig</p>
      <Heading headingRef={headingRef}>A browser that lets you keep your tabs.</Heading>
      <p className="welcome-lede">
        Tabs you aren&apos;t looking at fall asleep and cost almost nothing, so you never have to
        close things just to stay fast.
      </p>
      <p className="welcome-meta">About a minute. Every step can be skipped.</p>
    </>
  );
}

function StepYou({
  headingRef,
  imported,
  onImported,
}: HeadingRef & { imported: number | null; onImported: (n: number) => void }) {
  const profileName = useSettingsStore((s) => s.profileName);
  const setProfileName = useSettingsStore((s) => s.setProfileName);
  const [name, setName] = useState(profileName);
  const [browsers, setBrowsers] = useState<FoundBrowser[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    detectBrowsers()
      .then((found) => {
        setBrowsers(found);
        // Pre-select the one with the most bookmarks: that's almost always
        // the browser someone is actually coming from.
        const top = [...found].sort((a, b) => b.count - a.count)[0];
        if (top) setChosen(new Set([top.id]));
      })
      .catch(() => setBrowsers([]));
  }, []);

  const total = (browsers ?? []).filter((b) => chosen.has(b.id)).reduce((n, b) => n + b.count, 0);

  async function runImport() {
    setBusy(true);
    setError(null);
    try {
      const lists = await Promise.all([...chosen].map((id) => readBrowserBookmarks(id)));
      onImported(await importBookmarks(lists.flat()));
    } catch (cause) {
      setError(`Import stopped partway: ${String(cause)}. Anything already added is kept.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Heading headingRef={headingRef}>Make it yours</Heading>

      <label className="welcome-field">
        <span className="welcome-label">What should twig call you?</span>
        <input
          value={name}
          maxLength={40}
          spellCheck={false}
          autoComplete="given-name"
          placeholder="Your name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setProfileName(name)}
          onKeyDown={(e) => e.key === "Enter" && setProfileName(name)}
        />
        <span className="welcome-help">Used to greet you on new tabs. It never leaves this Mac.</span>
      </label>

      <div className="welcome-field">
        <span className="welcome-label">Bring your bookmarks</span>
        {browsers === null && <p className="welcome-help">Looking for other browsers…</p>}
        {browsers?.length === 0 && (
          <p className="welcome-help">No other browsers with bookmarks on this Mac — you&apos;re starting fresh.</p>
        )}
        {browsers && browsers.length > 0 && imported === null && (
          <>
            <div className="welcome-choices" role="group" aria-label="Browsers to import from">
              {browsers.map((b) => {
                const on = chosen.has(b.id);
                return (
                  <button
                    key={b.id}
                    className={on ? "welcome-choice on" : "welcome-choice"}
                    aria-pressed={on}
                    onClick={() => {
                      const nextSet = new Set(chosen);
                      if (on) nextSet.delete(b.id);
                      else nextSet.add(b.id);
                      setChosen(nextSet);
                    }}
                  >
                    <span className="welcome-check" aria-hidden="true">
                      {on && <Icon name="star-filled" size={10} />}
                    </span>
                    <span className="welcome-choice-name">{b.name}</span>
                    <span className="welcome-choice-count">{b.count.toLocaleString()}</span>
                  </button>
                );
              })}
            </div>
            <button className="welcome-secondary" disabled={busy || total === 0} onClick={runImport}>
              {busy ? "Importing…" : total ? `Import ${total.toLocaleString()} bookmarks` : "Choose a browser"}
            </button>
          </>
        )}
        {imported !== null && (
          <p className="welcome-done" role="status">
            <Icon name="star-filled" size={13} />
            {imported === 0
              ? "Those were all here already."
              : `Added ${imported.toLocaleString()} bookmark${imported === 1 ? "" : "s"}. Find them with ⇧⌘O.`}
          </p>
        )}
        {error && (
          <p className="welcome-error" role="alert">
            {error}
          </p>
        )}
        <span className="welcome-help">Safari isn&apos;t listed: its bookmarks need Full Disk Access.</span>
      </div>
    </>
  );
}

function StepLook({ headingRef }: HeadingRef) {
  const { themeMode, accentId, searchEngineId, setThemeMode, setAccent, setSearchEngineId } = useSettingsStore();
  const themes: { id: ThemeMode; label: string }[] = [
    { id: "system", label: "Match Mac" },
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
  ];
  return (
    <>
      <Heading headingRef={headingRef}>Pick a look</Heading>
      <p className="welcome-lede">Changes apply as you choose them — this screen included.</p>

      <div className="welcome-field">
        <span className="welcome-label">Appearance</span>
        <div className="segmented">
          {themes.map((t) => (
            <button
              key={t.id}
              className={t.id === themeMode ? "segment selected" : "segment"}
              aria-pressed={t.id === themeMode}
              onClick={() => setThemeMode(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="welcome-field">
        <span className="welcome-label">Accent</span>
        <div className="welcome-swatches">
          {ACCENT_SWATCHES.map((s) => (
            <button
              key={s.id}
              className={s.id === accentId ? "welcome-swatch on" : "welcome-swatch"}
              aria-pressed={s.id === accentId}
              onClick={() => setAccent(s.id)}
            >
              <span className="welcome-swatch-dot" style={{ background: s.light }} />
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="welcome-field">
        <span className="welcome-label">Search with</span>
        <div className="segmented">
          {SEARCH_ENGINES.map((e) => (
            <button
              key={e.id}
              className={e.id === searchEngineId ? "segment selected" : "segment"}
              aria-pressed={e.id === searchEngineId}
              onClick={() => setSearchEngineId(e.id)}
            >
              {e.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function StepTour({ headingRef, stop, tried }: HeadingRef & { stop: TourStop; tried: boolean }) {
  const hotCap = useSettingsStore((s) => s.hotCap);
  const setHotCap = useSettingsStore((s) => s.setHotCap);

  if (stop === "sleep") {
    return (
      <>
        <Heading headingRef={headingRef}>Tabs fall asleep</Heading>
        <p className="welcome-lede">
          Only a few tabs stay awake. The rest let go of their memory and wake, scrolled where you
          left them, the moment you click one. A tab that&apos;s playing something or holding text
          you haven&apos;t sent is never put to sleep.
        </p>
        <div className="welcome-field">
          <span className="welcome-label">How many stay awake</span>
          <div className="welcome-styles">
            {MEMORY_STYLES.map((m) => (
              <button
                key={m.id}
                className={m.cap === hotCap ? "welcome-style on" : "welcome-style"}
                aria-pressed={m.cap === hotCap}
                onClick={() => setHotCap(m.cap)}
              >
                <span className="welcome-style-name">{m.label}</span>
                <span className="welcome-style-blurb">{m.blurb}</span>
              </button>
            ))}
          </div>
        </div>
      </>
    );
  }

  if (stop === "palette") {
    return (
      <>
        <Heading headingRef={headingRef}>⌘K does almost everything</Heading>
        <p className="welcome-lede">
          Switch tabs, open a bookmark, search what you&apos;ve read, or run any command — without
          reaching for the mouse.
        </p>
        <p className={tried ? "welcome-try done" : "welcome-try"} role="status">
          {tried ? (
            <>
              <Icon name="star-filled" size={13} /> That&apos;s the palette. Esc puts it away.
            </>
          ) : (
            <>
              Try it now: press <kbd>⌘</kbd>
              <kbd>K</kbd>
            </>
          )}
        </p>
      </>
    );
  }

  if (stop === "recall") {
    return (
      <>
        <Heading headingRef={headingRef}>Find anything you&apos;ve read</Heading>
        <p className="welcome-lede">
          twig keeps the text of pages you read, on this Mac, so ⌘K can find a page by a phrase
          inside it — not just by its title. ⇧⌘F searches saved passages directly.
        </p>
        <p className="welcome-meta">Private windows keep nothing. Clear it all any time in Settings.</p>
      </>
    );
  }

  return (
    <>
      <Heading headingRef={headingRef}>Spaces, and places to come back to</Heading>
      <p className="welcome-lede">
        Spaces keep unrelated piles of tabs apart — work in one, a trip you&apos;re planning in
        another. When a space is worth keeping, ⇧⌘S saves a checkpoint you can reopen later or fork
        to try another direction.
      </p>
    </>
  );
}

function StepKeysIntro({ headingRef, changed }: HeadingRef & { changed: number }) {
  return (
    <>
      <Heading headingRef={headingRef}>Your shortcuts</Heading>
      <p className="welcome-lede">
        Everything in twig has a shortcut, and every one of them is yours to change.
      </p>
      <ul className="welcome-tips">
        <li>Click a shortcut, then press the new keys.</li>
        <li>
          <kbd>⌫</kbd> removes it, <kbd>esc</kbd> cancels.
        </li>
        <li>Include <kbd>⌘</kbd>, <kbd>⌃</kbd> or <kbd>⌥</kbd>, so it can&apos;t fire while you type.</li>
      </ul>
      <p className="welcome-meta">
        {changed === 0 ? "Using the defaults." : `${changed} changed from the defaults.`} Come back any
        time from Settings.
      </p>
    </>
  );
}

function StepReady({ headingRef, imported, changedKeys }: HeadingRef & { imported: number | null; changedKeys: number }) {
  const profileName = useSettingsStore((s) => s.profileName);
  const hotCap = useSettingsStore((s) => s.hotCap);
  const style = MEMORY_STYLES.find((m) => m.cap === hotCap);
  const facts = [
    imported ? `${imported.toLocaleString()} bookmarks brought over` : null,
    style ? `${style.label} memory — ${hotCap} tabs stay awake` : `${hotCap} tabs stay awake`,
    changedKeys ? `${changedKeys} shortcut${changedKeys === 1 ? "" : "s"} made your own` : null,
  ].filter(Boolean) as string[];

  return (
    <>
      <Heading headingRef={headingRef}>{profileName ? `You're set, ${profileName}.` : "You're set."}</Heading>
      <ul className="welcome-facts">
        {facts.map((f) => (
          <li key={f}>
            <Icon name="star-filled" size={12} />
            {f}
          </li>
        ))}
      </ul>
      <p className="welcome-meta">
        See this again from the twig menu, or by searching “welcome” in ⌘K.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------
// Stages - the right-hand side. Illustrative, drawn from the same tokens
// as the real chrome, so theme and accent changes show up here too.
// ---------------------------------------------------------------------

const SAMPLE_TITLES = [
  "Borrow checker, explained", "Flight options — Lisbon", "Q3 planning doc", "Recipe: miso soup",
  "Tauri 2 migration guide", "PR #412 · fix scroll", "Apartment listings", "WKWebView docs",
  "Typography primer", "Bike repair forum", "Quarterly numbers", "Concert tickets", "Cabin rentals", "Git internals",
];

function StageSleepingTabs({ awake: fixedAwake, total, caption }: { awake?: number; total: number; caption?: boolean }) {
  const hotCap = useSettingsStore((s) => s.hotCap);
  const awake = fixedAwake ?? Math.min(hotCap, total);
  return (
    <div className="stage-card">
      <div className="stage-tabs">
        {SAMPLE_TITLES.slice(0, total).map((title, i) => (
          <div key={title} className={i < awake ? "stage-tab awake" : "stage-tab asleep"} style={{ transitionDelay: `${i * 22}ms` }}>
            <span className="stage-tab-dot" />
            <span className="stage-tab-title">{title}</span>
            <span className="stage-tab-state">{i < awake ? "awake" : "asleep"}</span>
          </div>
        ))}
      </div>
      {caption && (
        <p className="stage-caption">
          {total} tabs open. {awake} of them using memory.
        </p>
      )}
      {!caption && (
        <p className="stage-caption">
          {awake} awake, {total - awake} asleep — only the awake ones cost memory.
        </p>
      )}
    </div>
  );
}

function StageYou({ imported }: { imported: number | null }) {
  const profileName = useSettingsStore((s) => s.profileName);
  const initial = (profileName.trim()[0] ?? "t").toUpperCase();
  return (
    <div className="stage-you">
      <span className="stage-avatar">{initial}</span>
      <p className="stage-greeting">{greeting(profileName)}</p>
      <p className="stage-caption">
        {imported ? `${imported.toLocaleString()} bookmarks, ready in ⇧⌘O` : "How new tabs will greet you"}
      </p>
    </div>
  );
}

function StageMiniWindow({ greet }: { greet?: boolean }) {
  const engineId = useSettingsStore((s) => s.searchEngineId);
  const profileName = useSettingsStore((s) => s.profileName);
  const engine = SEARCH_ENGINES.find((e) => e.id === engineId)?.label ?? "Google";
  return (
    <div className="mini">
      <div className="mini-titlebar">
        <span />
        <span />
        <span />
      </div>
      <div className="mini-strip">
        <span className="mini-tab active">New Tab</span>
        <span className="mini-tab">Reading list</span>
        <span className="mini-tab asleep">Docs</span>
      </div>
      <div className="mini-bar">
        <span className="mini-mark">twig</span>
        <span className="mini-omni">
          <Icon name="search" size={10} /> Search {engine} or enter address
        </span>
      </div>
      <div className="mini-page">
        <span className="mini-page-mark">twig</span>
        {greet && <span className="mini-page-greet">{greeting(profileName)}</span>}
        <span className="mini-page-search" />
        <span className="mini-page-grid">
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} />
          ))}
        </span>
      </div>
    </div>
  );
}

function StagePalette({ tried }: { tried: boolean }) {
  return (
    <div className="stage-press">
      <div className={tried ? "keycaps pressed" : "keycaps"}>
        <kbd>⌘</kbd>
        <kbd>K</kbd>
      </div>
      <div className="stage-mini-palette">
        <span className="smp-field">
          <Icon name="search" size={11} /> lisbon
        </span>
        <span className="smp-group">Open tabs</span>
        <span className="smp-row on">Flight options — Lisbon</span>
        <span className="smp-group">In pages you&apos;ve read</span>
        <span className="smp-row">
          Cabin rentals <em>…walking distance from <mark>Lisbon</mark>’s old town…</em>
        </span>
        <span className="smp-group">Commands</span>
        <span className="smp-row">
          Save checkpoint <kbd>⇧⌘S</kbd>
        </span>
      </div>
    </div>
  );
}

function StageRecall() {
  return (
    <div className="stage-card stage-recall">
      <p className="stage-recall-query">
        <Icon name="search" size={12} /> <span>the bit about two-phase borrows</span>
      </p>
      <article className="stage-recall-page">
        <p className="stage-recall-title">Borrow checker, explained</p>
        <p>
          …which is why the compiler accepts <mark>two-phase borrows</mark> here: the mutable borrow
          is reserved first and only activated once the arguments are evaluated…
        </p>
        <p className="stage-caption">Read 3 weeks ago · found by what it said, not what it was called</p>
      </article>
    </div>
  );
}

function StageSpaces() {
  return (
    <div className="stage-spaces">
      {[
        { name: "Work", tabs: ["Q3 planning doc", "PR #412 · fix scroll", "Quarterly numbers"] },
        { name: "Lisbon trip", tabs: ["Flight options — Lisbon", "Cabin rentals", "Concert tickets"] },
      ].map((space, i) => (
        <div key={space.name} className={i === 0 ? "stage-space front" : "stage-space"}>
          <span className="stage-space-name">
            <Icon name="split" size={11} /> {space.name}
          </span>
          {space.tabs.map((t) => (
            <span key={t} className="stage-space-tab">
              {t}
            </span>
          ))}
        </div>
      ))}
      <p className="stage-caption">
        <Icon name="fork" size={12} /> Checkpoint “Lisbon trip” saved — fork it to plan a second route.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------
// Shortcut editor. Lives in the stage on this step: it needs the room.
// ---------------------------------------------------------------------

const GROUP_ORDER = ["File", "Edit", "View", "History", "Tab", "twig"];
const GROUP_NAMES: Record<string, string> = { twig: "App" };

function KeyEditor({ onChangedCount }: { onChangedCount: (n: number) => void }) {
  const [bindings, setBindings] = useState<Binding[] | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; text: string; takeFrom?: string; accel?: string } | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    getKeymap().then(setBindings);
  }, []);

  const changed = useMemo(
    () => (bindings ?? []).filter((b) => canonAccel(b.current) !== canonAccel(b.default)),
    [bindings],
  );

  useEffect(() => {
    onChangedCount(changed.length);
  }, [changed.length, onChangedCount]);

  const save = useCallback(async (nextBindings: Binding[]) => {
    const overrides: Record<string, string> = {};
    for (const b of nextBindings) {
      if (canonAccel(b.current) !== canonAccel(b.default)) overrides[b.id] = b.current;
    }
    const previous = bindings;
    setBindings(nextBindings);
    try {
      await setKeymap(overrides);
    } catch (cause) {
      setBindings(previous);
      setProblem({ id: "", text: String(cause) });
    }
  }, [bindings]);

  const assign = useCallback((id: string, accel: string, takeFrom?: string) => {
    if (!bindings) return;
    save(
      bindings.map((b) =>
        b.id === id ? { ...b, current: accel } : b.id === takeFrom ? { ...b, current: "" } : b,
      ),
    );
  }, [bindings, save]);

  // While recording, the native menu is stripped of accelerators so the
  // keys arrive here instead of triggering the thing they're bound to.
  // Restored on every exit path, including unmount mid-recording.
  useEffect(() => {
    if (!recording || !bindings) return;
    suspendShortcuts(true);

    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      const result = recordKey(e);
      if (result.kind === "pending") return;
      if (result.kind === "cancel") return setRecording(null);
      if (result.kind === "clear") {
        assign(recording!, "");
        return setRecording(null);
      }
      if (result.kind === "invalid") {
        return setProblem({ id: recording!, text: result.reason });
      }
      const reserved = RESERVED[result.accel];
      if (reserved) {
        return setProblem({ id: recording!, text: `${displayAccel(result.accel).join("")} is macOS's ${reserved}.` });
      }
      const other = bindings!.find((b) => b.id !== recording && canonAccel(b.current) === result.accel);
      if (other) {
        setProblem({
          id: recording!,
          text: `${displayAccel(result.accel).join("")} already opens ${other.label}.`,
          takeFrom: other.id,
          accel: result.accel,
        });
        return setRecording(null);
      }
      setProblem(null);
      assign(recording!, result.accel);
      setRecording(null);
    }

    function onBlur() {
      setRecording(null);
    }

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      suspendShortcuts(false);
    };
  }, [recording, bindings, assign]);

  if (!bindings) return <p className="stage-caption">Loading shortcuts…</p>;

  const q = filter.trim().toLowerCase();
  const groups = GROUP_ORDER.map((g) => ({
    group: g,
    items: bindings.filter((b) => b.group === g && (!q || b.label.toLowerCase().includes(q))),
  })).filter((g) => g.items.length);

  return (
    <div className="keyed">
      <div className="keyed-head">
        <label className="keyed-filter">
          <Icon name="search" size={13} />
          <input
            value={filter}
            placeholder="Find a shortcut"
            spellCheck={false}
            aria-label="Find a shortcut"
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <button
          className="welcome-quiet"
          disabled={changed.length === 0}
          onClick={() => save(bindings.map((b) => ({ ...b, current: b.default })))}
        >
          Reset all
        </button>
      </div>

      {problem && problem.id === "" && (
        <p className="welcome-error" role="alert">
          {problem.text}
        </p>
      )}

      <div className="keyed-list">
        {groups.map(({ group, items }) => (
          <section key={group} className="keyed-group" aria-label={GROUP_NAMES[group] ?? group}>
            <h2>{GROUP_NAMES[group] ?? group}</h2>
            {items.map((b) => {
              const isRecording = recording === b.id;
              const custom = canonAccel(b.current) !== canonAccel(b.default);
              const glyphs = displayAccel(b.current);
              return (
                <div key={b.id} className={custom ? "keyed-row custom" : "keyed-row"}>
                  <span className="keyed-label">{b.label}</span>
                  <button
                    className={isRecording ? "keyed-chip recording" : "keyed-chip"}
                    data-recording={isRecording || undefined}
                    aria-label={`${b.label}: ${glyphs.length ? glyphs.join(" ") : "no shortcut"}. Press to change.`}
                    onClick={() => {
                      setProblem(null);
                      setRecording(isRecording ? null : b.id);
                    }}
                  >
                    {isRecording ? (
                      <span className="keyed-listening">Press keys…</span>
                    ) : glyphs.length ? (
                      glyphs.map((g, i) => <kbd key={i}>{g}</kbd>)
                    ) : (
                      <span className="keyed-none">None</span>
                    )}
                  </button>
                  <button
                    className="keyed-reset"
                    title={`Reset to ${displayAccel(b.default).join("") || "none"}`}
                    aria-label={`Reset ${b.label}`}
                    disabled={!custom}
                    onClick={() => assign(b.id, b.default)}
                  >
                    <Icon name="reload" size={12} />
                  </button>
                  {problem?.id === b.id && (
                    <p className="keyed-problem" role="alert">
                      {problem.text}
                      {problem.takeFrom && problem.accel && (
                        <button
                          className="keyed-take"
                          onClick={() => {
                            assign(b.id, problem.accel!, problem.takeFrom);
                            setProblem(null);
                          }}
                        >
                          Use it here instead
                        </button>
                      )}
                    </p>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
