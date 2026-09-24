# Page Change Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When you revisit a page whose text changed since you last read it, show a `● Changed · <date>` chip in the address bar. Clicking the chip opens a right-side panel that diffs the two versions.

**Architecture:** Recall already stores an immutable copy per text change (`recall_captures`). When a capture arrives, the frontend runs a pure decision function (`decide` in `src/lib/changes.ts`) against the most recent earlier copies, before indexing the new one. The result goes into a small Zustand store keyed by tab ID. The chip and panel read that store. Rust gains two things: `tabId` on the `page-captured` payload, and a `set_content_inset` command that shrinks the page webview from the right so the panel sits beside the page.

**Tech Stack:** Tauri 2 (Rust), React 19, TypeScript, Zustand 5, SQLite via `@tauri-apps/plugin-sql`, `diff` (jsdiff 9), `node:test`, and Playwright WebKit.

**Spec:** `docs/superpowers/specs/2026-09-24-page-change-detection-design.md`

## Global Constraints

- Commit messages: conventional style (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), **no AI attribution**. That means no `Co-Authored-By`, no "Generated with", no 🤖.
- Stage explicit paths only. Never `git add -A`, and never stage `.codex/`, `.cursor/`, `.grok/`, `.omx/` or `SESSION_CONTEXT.md`.
- Push to `origin main` once, at the end of the feature (Task 6).
- Zustand: select narrow values only, never the whole store.
- App shortcuts go through the menu-action bus (`useMenuAction`), never raw `keydown` listeners on `window`. Esc handled on the panel element itself is fine.
- Design tokens: `--accent`, `--accent-tint`, `--text`, `--text-muted`, `--surface`, `--border`, `--border-strong`, `--row-hover` and `var(--ease)`. No bounce easing, and no width or border-width transitions.
- The panel is 380px wide. Below an 880px window width it falls back to full-width plus `setOverlayActive(true, "changes")`.
- The 10-minute baseline rule, the 30% length guard, and the volatility rule (3 ratios > 0.5) are exact values.
- Screenshots come from the scripted WebKit run or the twig window only. Never capture the full desktop.
- Before every commit, run `npm test` and `npm run build`. Run `cargo check` in `src-tauri` when Rust changed.

## Review Focus

1. **Reloading a changed page** should keep the chip. It must not clear the chip just because the copy saved seconds ago is now the newest baseline. That's covered by `decide` returning `keep` when the baseline is under 10 minutes old (Task 1 test).
2. **Pages that differ only in "3 hours ago", "1.2k views" or clock times** must never show a chip (Task 1 test).
3. **A partial or lazy capture** that is much shorter than the stored copy must not show a chip (Task 1 test).
4. **Switching tabs while the panel is open** must close it and restore the page to full width (`set_content_inset(0)`) (Task 6 browser test).
5. **Forgetting the page in Recall while its chip is showing** must clear the chip (Task 6 browser test).

---

### Task 1: Pure change logic

**Files:**
- Modify: `package.json` and `package-lock.json` (add the `diff` dependency)
- Create: `src/lib/changes.ts`
- Test: `tests/changes.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `src/lib/changes.ts`):
  - `interface WordPart { text: string; kind: "same" | "added" | "removed" }`
  - `type PassageKind = "added" | "removed" | "edited" | "context"`
  - `interface Passage { kind: PassageKind; text: string; words?: WordPart[] }`
  - `interface DiffResult { passages: Passage[]; added: number; removed: number; edited: number; changedRatio: number }`
  - `type Hunk = Passage | { kind: "gap"; count: number }`
  - `interface StoredCopy { id: number; body: string; capturedAt: number }`
  - `interface PageChange { url: string; capturedAt: number; baselineId: number; baselineAt: number; currentBody: string; summary: { added: number; removed: number; edited: number } }`
  - `type Decision = { action: "keep" } | { action: "clear" } | { action: "set"; change: PageChange }`
  - `const BASELINE_MIN_AGE = 600_000`
  - `paragraphs(body: string): string[]`
  - `comparisonKey(paragraph: string): string`
  - `diffCopies(oldBody: string, newBody: string): DiffResult`
  - `hunks(passages: Passage[], context?: number): Hunk[]`
  - `isMeaningful(result: DiffResult, oldBody: string, newBody: string): boolean`
  - `isVolatile(ratios: number[]): boolean`
  - `hostOf(url: string): string`
  - `shortDate(at: number, now: number): string`
  - `decide(input: { url: string; body: string; capturedAt: number; copies: StoredCopy[]; muted: string[] }): Decision`. Here `copies` holds up to 3 earlier copies, newest first.

- [ ] **Step 1: Install jsdiff**

Run: `npm install diff@^9`
Expected: `package.json` `dependencies` gains `"diff": "^9.0.0"`. Version 9 ships its own TypeScript types, so don't add `@types/diff`.

- [ ] **Step 2: Write the failing tests**

Create `tests/changes.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const api = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/changes.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: api, URL, Date, require(name) { assert.equal(name, "diff"); return require("diff"); } });
const plain = (value) => JSON.parse(JSON.stringify(value));
const DAY = 86_400_000;
const now = 1_800_000_000_000;
const doc = (...paras) => paras.join("\n\n");
const base = doc("Intro to the runtime.", "Spawning tasks is cheap.", "Blocking calls stall the executor.", "See the changelog for details.");

test("paragraphs split on newlines, collapse whitespace and drop blanks", () => {
  assert.deepEqual(plain(api.paragraphs("  One   two \n\n\nThree\n  \n")), ["One two", "Three"]);
});

test("volatile tokens are masked only for comparison", () => {
  assert.equal(api.comparisonKey("Posted 3 hours ago · 1.2k views"), api.comparisonKey("Posted 4 hours ago · 1.3k views"));
  assert.equal(api.comparisonKey("Updated 5m ago at 10:42 PM"), api.comparisonKey("Updated 12m ago at 11:03 PM"));
  assert.equal(api.comparisonKey("Yesterday"), api.comparisonKey("today"));
  assert.notEqual(api.comparisonKey("Version 1.3 is deprecated"), api.comparisonKey("Version 1.4 is deprecated"));
});

test("added, removed and edited paragraphs are counted", () => {
  const next = doc("Intro to the runtime.", "Spawning tasks is cheap and fast.", "See the changelog for details.", "Runtime::block_on now panics inside async contexts.");
  const result = plain(api.diffCopies(base, next));
  assert.equal(result.edited, 1);
  assert.equal(result.removed, 1);
  assert.equal(result.added, 1);
  const edited = result.passages.find((p) => p.kind === "edited");
  assert.equal(edited.text, "Spawning tasks is cheap and fast.");
  assert.ok(edited.words.some((w) => w.kind === "added" && w.text.includes("fast")));
  assert.equal(result.passages.find((p) => p.kind === "removed").text, "Blocking calls stall the executor.");
  assert.ok(result.changedRatio > 0 && result.changedRatio <= 1);
});

test("an unrelated replacement is removed plus added, not edited", () => {
  const result = plain(api.diffCopies(doc("Alpha beta gamma delta."), doc("Completely different sentence here.")));
  assert.equal(result.edited, 0);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
});

test("mask-only differences are not meaningful", () => {
  const a = doc("Thread title", "Posted 3 hours ago", "Body text here.");
  const b = doc("Thread title", "Posted 5 hours ago", "Body text here.");
  assert.equal(api.isMeaningful(api.diffCopies(a, b), a, b), false);
});

test("a much shorter capture is treated as partial, not a change", () => {
  const short = doc("Intro to the runtime.");
  assert.equal(api.isMeaningful(api.diffCopies(base, short), base, short), false);
  const grown = base + "\n\nOne more paragraph.";
  assert.equal(api.isMeaningful(api.diffCopies(base, grown), base, grown), true);
});

test("volatile only when three consecutive ratios exceed one half", () => {
  assert.equal(api.isVolatile([0.9, 0.8, 0.7]), true);
  assert.equal(api.isVolatile([0.9, 0.8]), false);
  assert.equal(api.isVolatile([0.9, 0.4, 0.9]), false);
});

test("hunks keep one paragraph of context and count the gaps", () => {
  const ctx = (text) => ({ kind: "context", text });
  const passages = [ctx("a"), ctx("b"), ctx("c"), { kind: "added", text: "new" }, ctx("d"), ctx("e"), ctx("f")];
  assert.deepEqual(plain(api.hunks(passages)), [
    { kind: "gap", count: 2 }, ctx("c"), { kind: "added", text: "new" }, ctx("d"), { kind: "gap", count: 2 },
  ]);
});

test("hostOf and shortDate", () => {
  assert.equal(api.hostOf("https://docs.rs/tokio/latest"), "docs.rs");
  assert.equal(api.hostOf("not a url"), "");
  assert.equal(api.shortDate(now - 60_000, now), "today");
  assert.match(api.shortDate(now - 12 * DAY, now), /\d/);
});

test("decide: set, keep, clear", () => {
  const url = "https://docs.rs/tokio/latest";
  const changed = base + "\n\nRuntime::block_on now panics inside async contexts.";
  const old = { id: 7, body: base, capturedAt: now - 2 * DAY };

  const set = plain(api.decide({ url, body: changed, capturedAt: now, copies: [old], muted: [] }));
  assert.equal(set.action, "set");
  assert.deepEqual(set.change, { url, capturedAt: now, baselineId: 7, baselineAt: now - 2 * DAY, currentBody: changed, summary: { added: 1, removed: 0, edited: 0 } });

  // Reloading a changed page: the newest copy is seconds old, so keep what the chip already says.
  const fresh = { id: 8, body: changed, capturedAt: now - 30_000 };
  assert.equal(api.decide({ url, body: changed, capturedAt: now, copies: [fresh, old], muted: [] }).action, "keep");

  assert.equal(api.decide({ url, body: changed, capturedAt: now, copies: [], muted: [] }).action, "clear");
  assert.equal(api.decide({ url, body: base, capturedAt: now, copies: [old], muted: [] }).action, "clear");
  assert.equal(api.decide({ url, body: changed, capturedAt: now, copies: [old], muted: ["docs.rs"] }).action, "clear");
});

test("decide: a page that changes wholesale every visit is a feed", () => {
  const url = "https://news.example.com/";
  const page = (n) => doc(`Story ${n} alpha`, `Story ${n} beta`, `Story ${n} gamma`, `Story ${n} delta`);
  const copies = [
    { id: 3, body: page(3), capturedAt: now - 1 * DAY },
    { id: 2, body: page(2), capturedAt: now - 2 * DAY },
    { id: 1, body: page(1), capturedAt: now - 3 * DAY },
  ];
  assert.equal(api.decide({ url, body: page(4), capturedAt: now, copies, muted: [] }).action, "clear");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/changes.test.mjs`
Expected: FAIL with ENOENT for `src/lib/changes.ts`.

- [ ] **Step 4: Implement `src/lib/changes.ts`**

```ts
import { diffArrays, diffWordsWithSpace } from "diff";

export interface WordPart { text: string; kind: "same" | "added" | "removed" }
export type PassageKind = "added" | "removed" | "edited" | "context";
export interface Passage { kind: PassageKind; text: string; words?: WordPart[] }
export interface DiffResult { passages: Passage[]; added: number; removed: number; edited: number; changedRatio: number }
export type Hunk = Passage | { kind: "gap"; count: number };
export interface StoredCopy { id: number; body: string; capturedAt: number }
export interface PageChange {
  url: string;
  capturedAt: number;
  baselineId: number;
  baselineAt: number;
  currentBody: string;
  summary: { added: number; removed: number; edited: number };
}
export type Decision = { action: "keep" } | { action: "clear" } | { action: "set"; change: PageChange };

/** A copy newer than this is a reload, not "what you last read". */
export const BASELINE_MIN_AGE = 10 * 60 * 1000;

// Text that changes on every load without the page meaning anything
// different. Masked for comparison only; the panel shows the real words.
const VOLATILE: RegExp[] = [
  /\b\d+\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|months?|y|yrs?|years?)\s+ago\b/gi,
  /\b(?:just now|yesterday|today)\b/gi,
  /\b\d+(?:[.,]\d+)?\s*[km]?\s+(?:views?|comments?|likes?|replies|reply|points?|stars?|shares?|reactions?|upvotes?|followers?|reads?)\b/gi,
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]m)?\b/gi,
];

export function paragraphs(body: string): string[] {
  return body.split("\n").map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function comparisonKey(paragraph: string): string {
  return VOLATILE.reduce((text, pattern) => text.replace(pattern, "#"), paragraph.toLowerCase());
}

function wordParts(before: string, after: string): WordPart[] {
  return diffWordsWithSpace(before, after).map((part) => ({
    text: part.value,
    kind: part.added ? "added" : part.removed ? "removed" : "same",
  }));
}

/** Share of characters two paragraphs keep in common, 0..1. */
function similarity(words: WordPart[], before: string, after: string): number {
  const same = words.filter((w) => w.kind === "same").reduce((n, w) => n + w.text.trim().length, 0);
  return same / Math.max(before.length, after.length, 1);
}

export function diffCopies(oldBody: string, newBody: string): DiffResult {
  const before = paragraphs(oldBody);
  const after = paragraphs(newBody);
  const changes = diffArrays(before.map(comparisonKey), after.map(comparisonKey));
  const passages: Passage[] = [];
  let added = 0, removed = 0, edited = 0;
  let i = 0, j = 0;
  for (let c = 0; c < changes.length; c++) {
    const change = changes[c];
    if (!change.added && !change.removed) {
      for (let k = 0; k < change.count; k++) passages.push({ kind: "context", text: after[j + k] });
      i += change.count;
      j += change.count;
      continue;
    }
    // Gather the whole run of removals/additions so a paragraph that was
    // rewritten can be shown as one edit rather than a delete and an add.
    const olds: string[] = [];
    const news: string[] = [];
    while (c < changes.length && (changes[c].added || changes[c].removed)) {
      const run = changes[c];
      if (run.removed) { olds.push(...before.slice(i, i + run.count)); i += run.count; }
      else { news.push(...after.slice(j, j + run.count)); j += run.count; }
      c++;
    }
    c--;
    const paired = Math.min(olds.length, news.length);
    for (let k = 0; k < paired; k++) {
      const words = wordParts(olds[k], news[k]);
      if (similarity(words, olds[k], news[k]) >= 0.4) {
        passages.push({ kind: "edited", text: news[k], words });
        edited++;
      } else {
        passages.push({ kind: "removed", text: olds[k] }, { kind: "added", text: news[k] });
        removed++;
        added++;
      }
    }
    for (const text of olds.slice(paired)) { passages.push({ kind: "removed", text }); removed++; }
    for (const text of news.slice(paired)) { passages.push({ kind: "added", text }); added++; }
  }
  const larger = Math.max(before.length, after.length, 1);
  return { passages, added, removed, edited, changedRatio: Math.min(1, (added + removed + edited) / larger) };
}

/** Changed passages with `context` unchanged paragraphs either side; the
 *  rest collapse into counted gaps. */
export function hunks(passages: Passage[], context = 1): Hunk[] {
  const near = (i: number) => {
    for (let k = Math.max(0, i - context); k <= Math.min(passages.length - 1, i + context); k++) {
      if (passages[k].kind !== "context") return true;
    }
    return false;
  };
  const out: Hunk[] = [];
  let gap = 0;
  passages.forEach((passage, i) => {
    if (!near(i)) { gap++; return; }
    if (gap) out.push({ kind: "gap", count: gap });
    gap = 0;
    out.push(passage);
  });
  if (gap) out.push({ kind: "gap", count: gap });
  return out;
}

export function isMeaningful(result: DiffResult, oldBody: string, newBody: string): boolean {
  const a = oldBody.trim().length;
  const b = newBody.trim().length;
  // Lazy pages captured before they finished loading look like mass deletions.
  if (!a || !b || Math.min(a, b) < 0.3 * Math.max(a, b)) return false;
  return result.added + result.removed + result.edited > 0;
}

export function isVolatile(ratios: number[]): boolean {
  return ratios.length >= 3 && ratios.slice(0, 3).every((r) => r > 0.5);
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

export function shortDate(at: number, now: number): string {
  const a = new Date(at);
  const b = new Date(now);
  if (a.toDateString() === b.toDateString()) return "today";
  return a.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(a.getFullYear() === b.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** `copies` are up to three earlier saved copies of `url`, newest first. */
export function decide(input: { url: string; body: string; capturedAt: number; copies: StoredCopy[]; muted: string[] }): Decision {
  const { url, body, capturedAt, copies, muted } = input;
  const host = hostOf(url);
  if (!host || muted.includes(host)) return { action: "clear" };
  const baseline = copies[0];
  if (!baseline) return { action: "clear" };
  if (capturedAt - baseline.capturedAt < BASELINE_MIN_AGE) return { action: "keep" };
  const result = diffCopies(baseline.body, body);
  if (!isMeaningful(result, baseline.body, body)) return { action: "clear" };
  const ratios = [result.changedRatio];
  for (let k = 0; k + 1 < copies.length; k++) ratios.push(diffCopies(copies[k + 1].body, copies[k].body).changedRatio);
  if (isVolatile(ratios)) return { action: "clear" };
  return {
    action: "set",
    change: {
      url,
      capturedAt,
      baselineId: baseline.id,
      baselineAt: baseline.capturedAt,
      currentBody: body,
      summary: { added: result.added, removed: result.removed, edited: result.edited },
    },
  };
}
```

**Note:** `diffArrays` change objects carry `count` in jsdiff 9. If the type says `count?: number`, use `change.count ?? change.value.length` everywhere `count` is read.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/changes.test.mjs`
Expected: all 11 tests PASS. If the "unrelated replacement" test reports `edited: 1`, print `similarity` for that pair. The threshold is 0.4, and whitespace must not count as shared.

- [ ] **Step 6: Run the full suite and build**

Run: `npm test && npm run build`
Expected: all tests pass (38 existing + 11 new), and the build succeeds.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/lib/changes.ts tests/changes.test.mjs
git commit -m "feat: diff saved copies of a page and decide when a change is worth flagging"
```

---

### Task 2: Recall queries for earlier copies

**Files:**
- Modify: `src/lib/recall-db.ts` (append after `getRecallCopy`)
- Modify: `docs/superpowers/specs/2026-09-24-page-change-detection-design.md` (unit 2 names)
- Test: `tests/recall-db.test.mjs` (append)

**Interfaces:**
- Consumes: `StoredCopy` from `src/lib/changes.ts` (Task 1).
- Produces:
  - `copiesBefore(url: string, before: number, limit?: number): Promise<StoredCopy[]>`: newest first, from any space, `captured_at < before`, with `limit` clamped to 1..50 and defaulting to 3.
  - `copiesOf(url: string): Promise<{ id: number; capturedAt: number }[]>`: newest first, at most 200.

- [ ] **Step 1: Write the failing tests** (append to `tests/recall-db.test.mjs`; `setup`, `capture` and `now` already exist there)

```js
test("copiesBefore returns earlier copies across spaces, newest first", async () => {
  const db = setup();
  await db.indexRecall(capture({ body: "First version.", capturedAt: now - 3 * 3_600_000, spaceId: "work" }));
  await db.indexRecall(capture({ body: "Second version.", capturedAt: now - 2 * 3_600_000, spaceId: "home", spaceName: "Home" }));
  await db.indexRecall(capture({ body: "Third version.", capturedAt: now - 3_600_000 }));
  await db.indexRecall(capture({ url: "https://example.com/other", body: "Other page.", capturedAt: now - 3_600_000 }));
  const copies = await db.copiesBefore("https://example.com/a", now - 3_600_000);
  assert.deepEqual(copies.map((c) => c.body), ["Second version.", "First version."]);
  assert.equal(copies[0].capturedAt, now - 2 * 3_600_000);
  assert.equal(typeof copies[0].id, "number");
  assert.equal((await db.copiesBefore("https://example.com/a", now, 1)).length, 1);
  assert.deepEqual((await db.copiesOf("https://example.com/a")).map((c) => c.capturedAt), [now - 3_600_000, now - 2 * 3_600_000, now - 3 * 3_600_000]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/recall-db.test.mjs`
Expected: FAIL with `db.copiesBefore is not a function`.

- [ ] **Step 3: Implement** (in `src/lib/recall-db.ts`)

Add `import type { StoredCopy } from "./changes";` below the existing import. It's type-only, so it compiles away and the test's `require` shim is unaffected. Then append after `getRecallCopy`:

```ts
/** Saved copies of `url` from before `before`, newest first, in any space:
 *  what you last read, wherever you read it. */
export async function copiesBefore(url: string, before: number, limit = 3): Promise<StoredCopy[]> {
  await writes;
  return db.select<StoredCopy[]>(
    `SELECT id, body, captured_at AS capturedAt FROM recall_captures
     WHERE url = $1 AND captured_at < $2 ORDER BY captured_at DESC, id DESC LIMIT $3`,
    [url, before, bounded(limit, 3, 50) || 1],
  );
}

export async function copiesOf(url: string): Promise<{ id: number; capturedAt: number }[]> {
  await writes;
  return db.select<{ id: number; capturedAt: number }[]>(
    `SELECT id, captured_at AS capturedAt FROM recall_captures
     WHERE url = $1 ORDER BY captured_at DESC, id DESC LIMIT 200`,
    [url],
  );
}
```

In the spec, unit 2: replace the `latestCopyBefore` and `recentCopies` bullets with `copiesBefore(url, before, limit = 3)`. In unit 4 step 2, replace "Fetch `baseline = latestCopyBefore(url, captured_at)`" with "Fetch `copies = copiesBefore(url, captured_at, 3)`; `copies[0]` is the baseline". Replace step 4 with: "Volatility uses this change's ratio plus the ratios between consecutive earlier copies. If `isVolatile`, clear and stop." Also change "If it's under 10 minutes older than this capture, clear the tab's change and stop" to "…leave the tab's current change as it is (a reload)".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/recall-db.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm test && npm run build
git add src/lib/recall-db.ts tests/recall-db.test.mjs docs/superpowers/specs/2026-09-24-page-change-detection-design.md
git commit -m "feat: look up earlier saved copies of a page"
```

---

### Task 3: Native side: tab ID on captures, a right inset, and a menu action

**Files:**
- Modify: `src-tauri/src/tabs.rs`: the `IndexedPage` struct (~line 386), `Inner` plus `Default` (~440–480), `content_area`/`content_bounds`/`split_bounds` (~594–635), the `spawn_webview_with_script` bounds call (~661), the capture callback (~779–812), `sync_visible_webviews` (~851–870), and a new command after `set_content_offset` (~1505)
- Modify: `src-tauri/src/lib.rs` (register the command, next to `tabs::set_content_offset` ~line 157)
- Modify: `src-tauri/src/keymap.rs` (add an action after `show-recall`, ~line 64)
- Modify: `src/lib/tabs.ts` (add the `setContentInset` wrapper after `setContentOffset`)
- Modify: `src/lib/recall-db.ts` (`RecallCapture` gains `tabId?: string`)

**Interfaces:**
- Produces:
  - A Tauri event `page-captured` whose payload now includes `tabId: string`.
  - A Tauri command `set_content_inset { right: f64 }`.
  - A TS wrapper `setContentInset(right: number): Promise<void>`.
  - A menu action ID `"show-changes"` (label "Show What Changed…", History menu, no default shortcut).

- [ ] **Step 1: Add `tab_id` to the payload**

In `struct IndexedPage`, add `tab_id: String,` as the first field. In the capture callback, the closure moves `tab_id` into the validity check (`tab.id == tab_id`), so build the payload with `tab_id: tab_id.clone(),` inside the `IndexedPage { … }` literal. Run `grep -n "IndexedPage {" src-tauri/src/tabs.rs` and give every constructor the field. Anything other than the struct definition and this callback is a surprise worth reading first.

In `src/lib/recall-db.ts` `RecallCapture`, add `tabId?: string;` with the comment `// Set by native captures; used for change detection, never stored.` `indexRecall` inserts named columns only, so there's nothing else to change.

- [ ] **Step 2: Add the inset to layout**

In `struct Inner`, add below `content_offset`:

```rust
    /// Pixels reserved on the right for a chrome side panel (what changed on
    /// this page). Unlike `content_offset` this does resize the page - a
    /// side panel is read alongside the page, so the page must stay whole.
    content_inset: f64,
```

Add `content_inset: 0.0,` in `Default`. Change `content_area` to take `content_inset: f64` and subtract it from the width:

```rust
fn content_area<R: Runtime>(window: &Window<R>, tab_strip_visible: bool, content_inset: f64) -> tauri::Result<LogicalSize<f64>> {
    let scale = window.scale_factor()?;
    let logical = window.inner_size()?.to_logical::<f64>(scale);
    Ok(LogicalSize::new(
        (logical.width - content_inset).max(0.0),
        (logical.height - top_offset(window, tab_strip_visible)).max(0.0),
    ))
}
```

Add a trailing `content_inset: f64` parameter to `content_bounds` and `split_bounds`, and pass it through to `content_area`. Update the callers:
- `sync_visible_webviews`: pass `inner.content_inset` to both.
- `spawn_webview_with_script` (line ~661): pass `0.0`, with the comment `// Newly spawned tabs are re-placed by sync_visible_webviews, which applies the inset.`

Run `grep -n "content_bounds(\|split_bounds(\|content_area(" src-tauri/src/tabs.rs` to confirm there are no other callers.

- [ ] **Step 3: Add the command** (after `set_content_offset`)

```rust
/// Narrows the visible page from the right so a chrome side panel can sit
/// beside it. The page re-lays out at the narrower width; 0 restores it.
#[tauri::command]
pub fn set_content_inset<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    right: f64,
) -> Result<(), String> {
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);
    let right = right.max(0.0);
    if (inner.content_inset - right).abs() < f64::EPSILON {
        return Ok(());
    }
    inner.content_inset = right;
    sync_visible_webviews(&app, &window, inner);
    Ok(())
}
```

Register `tabs::set_content_inset,` directly after `tabs::set_content_offset,` in `lib.rs`.

- [ ] **Step 4: Add the menu action** (in `keymap.rs` `ACTIONS`, after `show-recall`)

```rust
    a("show-changes", "Show What Changed…", "History", "", false),
```

- [ ] **Step 5: Add the TS wrapper** (in `src/lib/tabs.ts` after `setContentOffset`)

```ts
/** Narrows the page from the right for a side panel read alongside it.
 *  Pass 0 to give the page its full width back. */
export function setContentInset(right: number): Promise<void> {
  return invoke("set_content_inset", { right });
}
```

- [ ] **Step 6: Verify**

Run: `cd src-tauri && cargo check && cd .. && npm test && npm run build`
Expected: cargo finishes with no errors, all tests pass, and the build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/tabs.rs src-tauri/src/lib.rs src-tauri/src/keymap.rs src/lib/tabs.ts src/lib/recall-db.ts
git commit -m "feat: tag captures with their tab and let a side panel narrow the page"
```

---

### Task 4: Change store and detection wiring

**Files:**
- Create: `src/store/changes.ts`
- Create: `src/lib/change-watch.ts`
- Modify: `src/App.tsx`: the `page-captured` listener (~lines 96–104), and a new effect for `watchChanges`

**Interfaces:**
- Consumes:
  - `decide`, `PageChange` and `StoredCopy` (Task 1);
  - `copiesBefore` and `getRecallCopy` (Task 2 and existing);
  - `RecallCapture` with `tabId` (Task 3);
  - `useTabStore` (existing).
- Produces:
  - `useChangeStore` with state `{ byTab: Record<string, PageChange>; openFor: string | null; muted: string[] }` and actions:
    - `set(tabId: string, change: PageChange): void`
    - `clear(tabId: string): void`
    - `prune(tabs: { id: string; url: string }[]): void`
    - `open(tabId: string): void`
    - `close(): void`
    - `mute(host: string): void`
    - `unmute(host: string): void`
  - `checkForChange(capture: RecallCapture): Promise<void>`
  - `watchChanges(): () => void`

- [ ] **Step 1: Create `src/store/changes.ts`**

```ts
import { create } from "zustand";
import type { PageChange } from "../lib/changes";

const MUTED_KEY = "twig:changes-muted";

function loadMuted(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(MUTED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function saveMuted(hosts: string[]) {
  try { localStorage.setItem(MUTED_KEY, JSON.stringify(hosts)); } catch { /* storage unavailable: mute lasts this session */ }
}

interface ChangeStore {
  /** Tab id -> what changed on the page it's showing. Absent = nothing to say. */
  byTab: Record<string, PageChange>;
  /** Tab whose changes panel is open. */
  openFor: string | null;
  muted: string[];
  set: (tabId: string, change: PageChange) => void;
  clear: (tabId: string) => void;
  /** Drops changes for tabs that closed or moved to another address. */
  prune: (tabs: { id: string; url: string }[]) => void;
  open: (tabId: string) => void;
  close: () => void;
  mute: (host: string) => void;
  unmute: (host: string) => void;
}

export const useChangeStore = create<ChangeStore>((set, get) => ({
  byTab: {},
  openFor: null,
  muted: loadMuted(),
  set: (tabId, change) => set((s) => ({ byTab: { ...s.byTab, [tabId]: change } })),
  clear: (tabId) => {
    if (!(tabId in get().byTab)) return;
    set((s) => {
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab, openFor: s.openFor === tabId ? null : s.openFor };
    });
  },
  prune: (tabs) => {
    const urls = new Map(tabs.map((t) => [t.id, t.url]));
    const stale = Object.entries(get().byTab).filter(([id, change]) => urls.get(id) !== change.url).map(([id]) => id);
    for (const id of stale) get().clear(id);
  },
  open: (tabId) => { if (get().byTab[tabId]) set({ openFor: tabId }); },
  close: () => set({ openFor: null }),
  mute: (host) => {
    if (!host || get().muted.includes(host)) return;
    const muted = [...get().muted, host].sort();
    saveMuted(muted);
    const byTab = Object.fromEntries(Object.entries(get().byTab).filter(([, c]) => {
      try { return new URL(c.url).hostname !== host; } catch { return true; }
    }));
    set({ muted, byTab, openFor: get().openFor && byTab[get().openFor!] ? get().openFor : null });
  },
  unmute: (host) => {
    const muted = get().muted.filter((h) => h !== host);
    saveMuted(muted);
    set({ muted });
  },
}));
```

- [ ] **Step 2: Create `src/lib/change-watch.ts`**

```ts
import { decide } from "./changes";
import { copiesBefore, getRecallCopy, type RecallCapture } from "./recall-db";
import { useChangeStore } from "../store/changes";
import { useTabStore } from "../store/tabs";

/** Compares a fresh capture with what you last read. Must run before the
 *  capture is indexed, or the capture would become its own baseline. */
export async function checkForChange(capture: RecallCapture): Promise<void> {
  const { tabId } = capture;
  if (!tabId) return;
  const copies = await copiesBefore(capture.url, capture.capturedAt, 3);
  const decision = decide({
    url: capture.url,
    body: capture.body,
    capturedAt: capture.capturedAt,
    copies,
    muted: useChangeStore.getState().muted,
  });
  // The tab may have moved on while the query ran.
  const tab = useTabStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab || tab.url !== capture.url) return;
  if (decision.action === "set") useChangeStore.getState().set(tabId, decision.change);
  else if (decision.action === "clear") useChangeStore.getState().clear(tabId);
}

/** Keeps flagged changes honest: gone when the tab navigates or closes,
 *  gone when the copy they compare against is forgotten. */
export function watchChanges(): () => void {
  const unsubscribe = useTabStore.subscribe((s) => useChangeStore.getState().prune(s.tabs));
  const recallChanged = () => {
    for (const [tabId, change] of Object.entries(useChangeStore.getState().byTab)) {
      getRecallCopy(change.baselineId)
        .then((copy) => { if (!copy) useChangeStore.getState().clear(tabId); })
        .catch(() => {});
    }
  };
  window.addEventListener("twig:recall-changed", recallChanged);
  return () => {
    unsubscribe();
    window.removeEventListener("twig:recall-changed", recallChanged);
  };
}
```

- [ ] **Step 3: Wire up `App.tsx`**

Add `import { checkForChange, watchChanges } from "./lib/change-watch";`. Replace the body of the `page-captured` listener with:

```ts
      (event) => {
        if (useTabStore.getState().isPrivate) return;
        const capture = event.payload;
        // Compare first: once indexed, this capture would be its own baseline.
        checkForChange(capture)
          .catch((cause) => console.warn("Change detection failed", cause))
          .finally(() => {
            indexPage(capture).catch((cause) => {
              window.dispatchEvent(new CustomEvent("twig:recall-index-error", { detail: String(cause) }));
            });
          });
      },
```

Add a separate effect below the existing one:

```ts
  useEffect(() => watchChanges(), []);
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run build`
Expected: pass. `tests/recall-browser.mjs` fires `page-captured` without `tabId`; `checkForChange` returns early, so indexing is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/store/changes.ts src/lib/change-watch.ts src/App.tsx
git commit -m "feat: notice when a page you revisit has changed since you read it"
```

---

### Task 5: Chip, panel, palette command, and settings

**Files:**
- Create: `src/components/Changes.tsx`, `src/components/Changes.css`
- Modify: `src/components/AddressBar.tsx` (chip before the star, ~line 369) and `src/components/AddressBar.css`
- Modify: `src/components/CommandPalette.tsx` (`COMMAND_MENU_IDS`, the commands list, the deps array)
- Modify: `src/components/SettingsPanel.tsx` (muted hosts in the Data section, after the History row)
- Modify: `src/App.tsx` (render `<Changes />` after `<Recall />`)

**Interfaces:**
- Consumes:
  - `useChangeStore` (Task 4);
  - `diffCopies`, `hunks`, `shortDate`, `hostOf`, `Hunk` and `PageChange` (Task 1);
  - `copiesOf` and `getRecallCopy` (Task 2);
  - `setContentInset` (Task 3) and `setOverlayActive`;
  - `useMenuAction`, `openRecall`, and `Icon` names that already exist (`close`, `recall`).
- Produces the DOM contract used by Task 6:
  - the chip is `button.change-chip`, with text matching `/^Changed · /`;
  - the panel is `aside[aria-label="Changes to this page"]`;
  - the heading is `h2#changes-heading`, "What changed since you read it";
  - passages are `.change-passage.added|removed|edited|context`, and gaps are `.change-gap`;
  - the mute button has the accessible name `Don't flag changes on <host>`;
  - the compare selector is `select[aria-label="Compare with"]`.

- [ ] **Step 1: Add the chip to `AddressBar.tsx`**

Imports:

```ts
import { useChangeStore } from "../store/changes";
import { shortDate } from "../lib/changes";
```

Next to the other store selectors:

```ts
  const change = useChangeStore((s) => (activeId ? s.byTab[activeId] : undefined));
  const openChanges = useChangeStore((s) => s.open);
```

Directly before the `{!internal && !isPrivate && ( <button className={bookmarked ? …` star block:

```tsx
        {change && !internal && !isPrivate && !editing && (
          <button
            className="change-chip"
            title={`Changed since you read it on ${new Date(change.baselineAt).toLocaleString()}`}
            onClick={() => activeId && openChanges(activeId)}
          >
            <span className="change-dot" aria-hidden="true" />
            Changed · {shortDate(change.baselineAt, Date.now())}
          </button>
        )}
```

Append to `AddressBar.css`:

```css
.change-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  height: 24px;
  margin-right: 4px;
  padding: 0 9px;
  border: 0;
  border-radius: 999px;
  background: var(--accent-tint);
  color: var(--text);
  font: inherit;
  font-size: 11.5px;
  font-weight: 550;
  white-space: nowrap;
  cursor: default;
  transition: background-color 160ms var(--ease);
}
.change-chip:hover { background: color-mix(in srgb, var(--accent) 22%, var(--surface)); }
.change-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.change-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
```

- [ ] **Step 2: Create `src/components/Changes.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useTabStore } from "../store/tabs";
import { useChangeStore } from "../store/changes";
import { diffCopies, hostOf, hunks, shortDate, type Hunk, type PageChange } from "../lib/changes";
import { copiesOf, getRecallCopy } from "../lib/recall-db";
import { openRecall } from "../lib/recall";
import { setContentInset, setOverlayActive } from "../lib/tabs";
import { useMenuAction } from "../lib/menu";
import { Icon } from "./Icon";
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
```

The `Icon` names `close` and `recall` already exist. The app has no visually-hidden utility; `Changes.css` defines `.changes .visually-hidden` in Step 3.

- [ ] **Step 3: Create `src/components/Changes.css`**

```css
.changes {
  position: fixed;
  right: 0;
  bottom: 0;
  z-index: 900;
  display: flex;
  flex-direction: column;
  width: 380px;
  border-left: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  animation: changes-in 220ms var(--ease);
}
.changes.narrow { width: 100%; border-left: 0; }
@keyframes changes-in { from { transform: translateX(16px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .changes { animation: none; } }
.changes :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.changes-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 18px 8px; }
.changes h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.changes h2:focus { outline: none; }
.changes-range { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.changes-icon { display: inline-flex; padding: 6px; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted); }
.changes-icon:hover { background: var(--row-hover); color: var(--text); }
.changes-counts { display: flex; gap: 10px; margin: 0; padding: 0 18px 12px; border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 550; font-variant-numeric: tabular-nums; }
.changes-counts .added { color: var(--accent); }
.changes-counts .removed, .changes-counts .edited { color: var(--text-muted); }
.changes-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 18px; scrollbar-color: var(--border-strong) transparent; }
.change-passage { margin: 0 0 10px; padding: 6px 10px; border-left: 3px solid transparent; border-radius: 0 6px 6px 0; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.change-passage.added { border-left-color: var(--accent); background: var(--accent-tint); }
.change-passage.removed { border-left-color: var(--border-strong); color: var(--text-muted); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--text-muted) 60%, transparent); }
.change-passage.edited { border-left-color: color-mix(in srgb, var(--accent) 55%, transparent); }
.change-passage.context { color: var(--text-muted); }
.change-passage ins { background: color-mix(in srgb, var(--accent) 26%, var(--surface)); text-decoration: none; border-radius: 2px; }
.change-passage del { color: var(--text-muted); }
.change-gap { margin: 0 0 10px; color: var(--text-muted); font-size: 11.5px; }
.changes-empty { color: var(--text-muted); font-size: 13px; }
.changes-footer { display: flex; flex-direction: column; gap: 10px; padding: 12px 18px 16px; border-top: 1px solid var(--border); }
.changes-compare { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-muted); }
.changes-compare select { flex: 1; height: 30px; padding: 3px 6px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; font-size: 12px; }
.changes-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.changes-button { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 6px 10px; border: 1px solid var(--border-strong); border-radius: 7px; background: transparent; color: var(--text); font: inherit; font-size: 12px; }
.changes-button:hover { background: var(--row-hover); }
.changes-button.quiet { border-color: transparent; color: var(--text-muted); }
.changes .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
```

- [ ] **Step 4: Render it.** In `App.tsx`, add `import { Changes } from "./components/Changes";` and put `<Changes />` right after `<Recall />`.

- [ ] **Step 5: Add the palette command** (`CommandPalette.tsx`)

- Add `"cmd-changes": "show-changes",` to `COMMAND_MENU_IDS`.
- Add `import { useChangeStore } from "../store/changes";`.
- Add a selector next to the others: `const hasChange = useChangeStore((s) => (activeId ? !!s.byTab[activeId] : false));`. Use whatever `activeId` variable the palette already has in scope.
- Inside the `if (!isPrivate) { … commands.push(` block, append:

```ts
      if (activeId && hasChange) {
        commands.unshift({ key: "cmd-changes", kind: "command", label: "Show what changed", icon: "recall", run: () => useChangeStore.getState().open(activeId) });
      }
```

- Add `hasChange` to the `useMemo` deps array.

- [ ] **Step 6: Add muted hosts to Settings** (`SettingsPanel.tsx`, in the Data section, directly after the History `settings-row`)

Import: `import { useChangeStore } from "../store/changes";`. Selectors: `const muted = useChangeStore((s) => s.muted);` and `const unmute = useChangeStore((s) => s.unmute);`. Markup:

```tsx
            {muted.map((host) => (
              <div className="settings-row" key={host}>
                <span className="settings-label">
                  {host}
                  <span className="settings-sub">Changes on this site aren&apos;t flagged</span>
                </span>
                <button className="settings-button" onClick={() => unmute(host)}>
                  Flag again
                </button>
              </div>
            ))}
```

- [ ] **Step 7: Verify**

Run: `npm test && npm run build`
Expected: pass, with no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/Changes.tsx src/components/Changes.css src/components/AddressBar.tsx src/components/AddressBar.css src/components/CommandPalette.tsx src/components/SettingsPanel.tsx src/App.tsx
git commit -m "feat: show what changed on a page, beside the page"
```

---

### Task 6: Browser test, visual check, docs, push

**Files:**
- Create: `tests/changes-browser.mjs`
- Modify: `docs/recall.md` (new section before "## Verification") and `README.md` (feature list)

**Interfaces:**
- Consumes: the DOM contract from Task 5, the `page-captured` payload shape from Task 3, and the `twig:changes-muted` storage key from Task 4.

- [ ] **Step 1: Write `tests/changes-browser.mjs`**

```js
// Drives change detection in WebKit against the running Vite dev server,
// with the Tauri bridge mocked and SQLite in memory.
//
//   npm run dev
//   TWIG_PLAYWRIGHT_MODULE=/path/to/playwright CAPTURE=1 node tests/changes-browser.mjs
const { webkit } = await import(process.env.TWIG_PLAYWRIGHT_MODULE || "playwright");
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const url = process.env.TWIG_TEST_URL || "http://localhost:1420";
const shots = mkdtempSync(join(tmpdir(), "twig-changes-"));
const capture = !!process.env.CAPTURE;
const DAY = 86_400_000;
const PAGE = "https://docs.example.com/guide";

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE bookmarks(id INTEGER PRIMARY KEY, url TEXT UNIQUE, title TEXT, created_at INTEGER);
         CREATE TABLE history(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visited_at INTEGER);
         CREATE TABLE archive(id INTEGER PRIMARY KEY, url TEXT, title TEXT, closed_at INTEGER);
         CREATE VIRTUAL TABLE page_text USING fts5(url UNINDEXED, title, body, captured_at UNINDEXED, tokenize='porter unicode61');`);
db.exec(readFileSync(new URL("../src-tauri/migrations/005_recall.sql", import.meta.url), "utf8"));
const oldBody = ["Getting started with the runtime.", "Spawning tasks is cheap.", "Blocking calls stall the executor.",
  "Use channels to talk between tasks.", "See the changelog for details."].join("\n\n");
const newBody = ["Getting started with the runtime.", "Spawning tasks is cheap and fast.",
  "Use channels to talk between tasks.", "See the changelog for details.", "Runtime::block_on now panics inside async contexts."].join("\n\n");
db.prepare(`INSERT INTO recall_captures (url, title, body, captured_at, space_id, space_name, session_id) VALUES (?, ?, ?, ?, '1', 'Space 1', 's0')`)
  .run(PAGE, "Guide", oldBody, Date.now() - 12 * DAY);

const browser = await webkit.launch();
const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, colorScheme: "light", deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.exposeFunction("testSql", (command, query, values) => {
  const statement = db.prepare(query);
  const bindings = Object.fromEntries((values ?? []).map((v, i) => ["$" + (i + 1), v]));
  if (command === "plugin:sql|select") return statement.all(bindings);
  const r = statement.run(bindings);
  return [Number(r.changes), Number(r.lastInsertRowid)];
});

await page.addInitScript((pageUrl) => {
  localStorage.setItem("twig:welcome-done", "1");
  const callbacks = new Map();
  const listeners = new Map();
  let next = 1;
  window.calls = [];
  window.testState = {
    tabs: [{ id: "1", url: pageUrl, title: "Guide", status: "hot", groupId: "1" }, { id: "2", url: "https://other.example.com/", title: "Other", status: "hot", groupId: "1" }],
    activeId: "1", splitId: null, groups: [{ id: "1", name: "Space 1" }], activeGroupId: "1", tabStripVisible: true, isPrivate: false,
  };
  window.fireEvent = (event, payload) => { for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ payload }); };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback(cb) { const id = next++; callbacks.set(id, cb); return id; },
    async invoke(command, args = {}) {
      window.calls.push({ command, args });
      if (command === "plugin:event|listen") {
        listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]);
        return args.handler;
      }
      if (command.startsWith("plugin:sql|")) return window.testSql(command, args.query, args.values);
      if (command === "list_tabs") return structuredClone(window.testState);
      if (command === "activate_tab") {
        window.testState.activeId = args.id;
        window.fireEvent("tabs-changed", structuredClone(window.testState));
        return null;
      }
      if (command === "get_keymap") return [];
      if (command === "memory_stats") return { footprintKb: 0, processCount: 0, awakeTabs: 0, sleepingTabs: 0, estimatedSavedKb: 0 };
      return null;
    },
  };
}, PAGE);

async function shot(name) {
  if (!capture) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}
// Dev runs under React.StrictMode, which mounts effects twice, so only the
// latest inset is meaningful.
const lastInset = () => page.evaluate(() => window.calls.filter((c) => c.command === "set_content_inset").at(-1)?.args.right);
async function eventually(check, what) {
  for (let i = 0; i < 40; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 50)); }
  assert.fail(`timed out waiting for ${what}`);
}
const captureNow = (body) => page.evaluate(({ pageUrl, body }) => window.fireEvent("page-captured", {
  tabId: "1", url: pageUrl, title: "Guide", body, capturedAt: Date.now(), spaceId: "1", spaceName: "Space 1", sessionId: "s1",
}), { pageUrl: PAGE, body });
const chip = page.locator("button.change-chip");
const panel = page.getByRole("complementary", { name: "Changes to this page" });

try {
  await page.goto(url);
  await page.locator(".address-bar").waitFor();

  // Revisit with changed text: chip appears, and the capture is still indexed.
  await captureNow(newBody);
  await chip.waitFor();
  assert.match(await chip.textContent(), /^Changed · /);
  await eventually(() => db.prepare("SELECT COUNT(*) n FROM recall_captures").get().n === 2, "the capture to be indexed");
  await shot("1-chip");

  // Panel opens beside the page and shows the real differences.
  await chip.click();
  await panel.waitFor();
  assert.equal(await lastInset(), 380);
  assert.equal(await panel.locator(".change-passage.added").first().textContent(), "Added: Runtime::block_on now panics inside async contexts.");
  assert.equal(await panel.locator(".change-passage.removed").count(), 1);
  assert.ok(await panel.locator(".change-passage.edited ins").count() >= 1);
  await shot("2-panel");

  // Esc closes and gives the page its width back.
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  assert.equal(await lastInset(), 0);

  // A reload seconds later keeps the chip (Review Focus 1).
  await captureNow(newBody);
  await page.waitForTimeout(200);
  assert.equal(await chip.count(), 1, "reload must not clear the chip");

  // Switching tabs closes the panel and restores width (Review Focus 4).
  await chip.click();
  await panel.waitFor();
  await page.evaluate(() => { window.testState.activeId = "2"; window.fireEvent("tabs-changed", structuredClone(window.testState)); });
  await panel.waitFor({ state: "detached" });
  assert.equal(await lastInset(), 0);
  await page.evaluate(() => { window.testState.activeId = "1"; window.fireEvent("tabs-changed", structuredClone(window.testState)); });
  await chip.waitFor();

  // Forgetting the page in Recall clears the chip (Review Focus 5).
  db.exec(`DELETE FROM recall_captures WHERE url = '${PAGE}'`);
  await page.evaluate(() => window.dispatchEvent(new Event("twig:recall-changed")));
  await chip.waitFor({ state: "detached" });

  // Re-seed so the page is flagged again.
  db.prepare(`INSERT INTO recall_captures (url, title, body, captured_at, space_id, space_name, session_id) VALUES (?, 'Guide', ?, ?, '1', 'Space 1', 's0')`)
    .run(PAGE, oldBody, Date.now() - 12 * DAY);
  await captureNow(newBody);
  await chip.waitFor();

  // Navigating the tab elsewhere drops the chip.
  await page.evaluate(() => { window.testState.tabs[0].url = "https://docs.example.com/other"; window.fireEvent("tabs-changed", structuredClone(window.testState)); });
  await chip.waitFor({ state: "detached" });
  await page.evaluate((pageUrl) => { window.testState.tabs[0].url = pageUrl; window.fireEvent("tabs-changed", structuredClone(window.testState)); }, PAGE);
  db.exec(`DELETE FROM recall_captures WHERE url = '${PAGE}'`);
  db.prepare(`INSERT INTO recall_captures (url, title, body, captured_at, space_id, space_name, session_id) VALUES (?, 'Guide', ?, ?, '1', 'Space 1', 's0')`)
    .run(PAGE, oldBody, Date.now() - 12 * DAY);
  await captureNow(newBody);
  await chip.waitFor();

  // Mute from the panel.
  await chip.click();
  await page.getByRole("button", { name: "Don't flag changes on docs.example.com" }).click();
  await chip.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("twig:changes-muted"))), ["docs.example.com"]);

  assert.deepEqual(errors, []);
  console.log("changes-browser: ok" + (capture ? ` — screenshots in ${shots}` : ""));
} finally {
  await browser.close();
}
```

- [ ] **Step 2: Run it against the dev server**

Run: start `npm run dev` in the background (port 1420), then:
`TWIG_PLAYWRIGHT_MODULE=/Users/yash/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs CAPTURE=1 node tests/changes-browser.mjs`
Expected: `changes-browser: ok — screenshots in …`. If a step fails, fix the product code, not the assertion, unless the assertion contradicts the spec.

- [ ] **Step 3: Look at the screenshots**

Read `1-chip.png` and `2-panel.png` with the Read tool. Check four things:
- the chip sits inside the omnibox, left of the star, and doesn't wrap;
- the panel sits flush right below the chrome;
- the added passage has the moss rule and the removed one is struck through;
- nothing overlaps the address bar.

Fix anything off and re-run.

- [ ] **Step 4: Write the docs**

In `docs/recall.md`, before `## Verification`, add:

```markdown
## Changes since you last read

When a page you've read before loads again, twig compares its text with the most recent saved copy, from any space, before saving the new one. If paragraphs were added, removed or rewritten, a **Changed · date** chip appears in the address bar. Click it, or use ⌘K → "Show what changed", to see the differences in a panel beside the page. You can also compare against any older copy.

The chip stays quiet when:
- the only differences are relative times, counters or clock times ("3 hours ago", "1.2k views");
- the saved copy is less than 10 minutes old, as with a reload;
- one copy is under 30% the length of the other, which usually means a partial load;
- the page has changed wholesale three visits running, as a feed does;
- you've muted the site from the panel.

Muted sites are listed in **Settings → Data**. Nothing is fetched in the background: changes are noticed only when you open the page yourself.
```

In `README.md`, add a bullet next to the Recall feature: `- **Changes since you last read** — revisit a page and twig shows what changed in its text since your last visit.`

- [ ] **Step 5: Final verification**

Run: `npm test && npm run build && (cd src-tauri && cargo check)`
Expected: everything passes.

- [ ] **Step 6: Commit and push**

```bash
git add tests/changes-browser.mjs docs/recall.md README.md
git commit -m "test: drive change detection end to end, and document it"
git push origin main
```
