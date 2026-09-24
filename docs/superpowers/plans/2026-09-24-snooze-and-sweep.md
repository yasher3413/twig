# Snooze and Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let you snooze a tab until a chosen time, after which it comes back by itself, asleep, in its original space. Also suggest archiving tabs you haven't touched in weeks.

**Architecture:** A snooze is a real close plus a row in a new `snoozed` SQLite table. A clock in the main window's chrome reopens due rows through a new Rust command, `open_background_tab`, which inserts a hibernated tab without changing focus. Rust starts recording a wall-clock `last_used_ms` per tab and persists it in the session file. Pure frontend rules (`sweep.ts`) turn that into a "N untouched tabs" pill and a review panel that sits beside the page, the same way the Changes panel does.

**Tech Stack:** Tauri 2 (Rust), React 19, TypeScript, Zustand 5, SQLite via `@tauri-apps/plugin-sql`, `node:test`, and Playwright WebKit 1.63.

**Spec:** `docs/superpowers/specs/2026-09-24-snooze-and-sweep-design.md`

## Global Constraints

- Commit messages: conventional style, **no AI attribution** (no `Co-Authored-By`, no "Generated with", no 🤖).
- Stage explicit paths only. Never `git add -A`, and never stage `.codex/`, `.cursor/`, `.grok/`, `.omx/` or `SESSION_CONTEXT.md`.
- Push to `origin main` only at the end (Task 6), after the final review.
- Zustand: select narrow values only. App shortcuts go through `useMenuAction`, never raw window `keydown` listeners. Handlers on a dialog's own element are fine.
- Overlays over native tab webviews must use `setOverlayActive(open, owner)` or `setContentInset(px)`.
- Exact values:
  - `SWEEP_CHOICES = [0, 7, 21, 30]`, default `21`
  - `MIN_STALE = 3`
  - `DISMISS_FOR = 7 days`
  - wake clock delay `max(1000, min(max(next - now, 0), 60_000))`
  - `MAX_FAILURES = 3`
  - panel width `380`, narrow breakpoint `880`
  - shortcut `CmdOrCtrl+Alt+S`
  - localStorage keys `twig:sweep-days` and `twig:sweep-dismissed-until`
  - DOM events `twig:snoozed-changed`, and `focus` on window
- Preset times: `hour` = +60 min; `evening` = 18:00 today, or tomorrow if the hour is ≥ 17; `tomorrow` = 09:00; `weekend` = the next Saturday strictly after today, 09:00; `week` = the next Monday strictly after today, 09:00.
- Only the window labelled `main` runs the wake clock. Private windows never snooze, sweep or show the Snoozed shelf.
- Before every commit, run `npm test` and `npm run build`. When Rust changed, also run `cd src-tauri && cargo check && cargo test`.
- Screenshots come from the scripted WebKit run only.

## Review Focus

1. **A wake time that passed while twig was closed** must bring the tab back right after launch, without waiting a minute (Task 6 browser test: row seeded in the past before load).
2. **A snoozed tab whose space was deleted** must land in the current space, not vanish or error (Task 3 Rust test on `landing_group`).
3. **A snoozed URL that can't reopen** must be retried, then moved to Closed tabs after 3 failures. It must not retry forever or get lost (Task 6 browser test with a mocked failure).
4. **Private windows** must show no moon button and no sweep pill (Task 6 browser test).
5. **Tabs carried over from before this feature** must never count as stale on first launch (Task 3 Rust test: a missing `last_used_ms` becomes now).

---

### Task 1: Pure snooze and sweep rules

**Files:**
- Create: `src/lib/snooze.ts` and `src/lib/sweep.ts`
- Modify: `src/lib/tabs.ts` (the `Tab` interface gains `lastUsedAt: number`)
- Test: `tests/snooze.test.mjs` and `tests/sweep.test.mjs`

**Interfaces:**
- Produces from `src/lib/snooze.ts`:
  - `type PresetId = "hour" | "evening" | "tomorrow" | "weekend" | "week"`
  - `interface SnoozePreset { id: PresetId; label: string; detail: string; at: number }`
  - `snoozePresets(now: Date): SnoozePreset[]`, always 5 presets in the order hour, evening, tomorrow, weekend, week
  - `customWakeAt(value: string, now: number): number | null`
  - `nextDelay(nextWakeAt: number | null, now: number): number`
  - `wakeLabel(at: number, now: number): string`
  - `dateTimeValue(d: Date): string`, local `YYYY-MM-DDTHH:MM`
- Produces from `src/lib/sweep.ts`:
  - `DAY = 86_400_000`
  - `SWEEP_CHOICES: readonly [0, 7, 21, 30]`
  - `DEFAULT_SWEEP_DAYS = 21`
  - `DISMISS_FOR = 7 * DAY`
  - `MIN_STALE = 3`
  - `staleTabs(tabs: Tab[], activeId: string | null, splitId: string | null, now: number, thresholdDays: number): Tab[]`
  - `shouldSuggest(stale: Tab[], dismissedUntil: number, now: number): boolean`
  - `sweepChoiceLabel(days: number): string`

- [ ] **Step 1: Write the failing tests**

`tests/snooze.test.mjs`:

```js
process.env.TZ = "America/New_York";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const api = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/snooze.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: api, Date, Math, Number });
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const byId = (presets) => Object.fromEntries(presets.map((p) => [p.id, p]));

test("presets on a Tuesday morning", () => {
  const now = local(2026, 9, 22, 10, 0); // Tue
  const p = byId(api.snoozePresets(now));
  assert.deepEqual(api.snoozePresets(now).map((x) => x.id), ["hour", "evening", "tomorrow", "weekend", "week"]);
  assert.equal(p.hour.at, now.getTime() + 3_600_000);
  assert.equal(p.evening.at, local(2026, 9, 22, 18).getTime());
  assert.equal(p.evening.label, "This evening");
  assert.equal(p.tomorrow.at, local(2026, 9, 23, 9).getTime());
  assert.equal(p.weekend.at, local(2026, 9, 26, 9).getTime());
  assert.equal(p.weekend.label, "This weekend");
  assert.equal(p.week.at, local(2026, 9, 28, 9).getTime());
  assert.match(p.evening.detail, /^today 6:00\sPM$/u);
});

test("late in the day, evening means tomorrow evening", () => {
  const p = byId(api.snoozePresets(local(2026, 9, 22, 17, 30)));
  assert.equal(p.evening.at, local(2026, 9, 23, 18).getTime());
  assert.equal(p.evening.label, "Tomorrow evening");
});

test("on a weekend, the weekend preset is next weekend", () => {
  const sat = byId(api.snoozePresets(local(2026, 9, 26, 8, 0)));
  assert.equal(sat.weekend.at, local(2026, 10, 3, 9).getTime());
  assert.equal(sat.weekend.label, "Next weekend");
  assert.equal(sat.week.at, local(2026, 9, 28, 9).getTime());
  const sun = byId(api.snoozePresets(local(2026, 9, 27, 12, 0)));
  assert.equal(sun.weekend.at, local(2026, 10, 3, 9).getTime());
  assert.equal(sun.week.at, local(2026, 9, 28, 9).getTime());
});

test("month ends and daylight saving roll over in local time", () => {
  const jan31 = byId(api.snoozePresets(local(2026, 1, 31, 10)));
  assert.equal(jan31.tomorrow.at, local(2026, 2, 1, 9).getTime());
  // US DST starts Sun 8 Mar 2026: that day is 23 hours long.
  const tomorrow = new Date(byId(api.snoozePresets(local(2026, 3, 7, 10))).tomorrow.at);
  assert.equal(tomorrow.getDate(), 8);
  assert.equal(tomorrow.getHours(), 9);
});

test("custom times must be at least a minute ahead", () => {
  const now = local(2026, 9, 22, 10, 0).getTime();
  assert.equal(api.customWakeAt("2026-09-22T09:00", now), null);
  assert.equal(api.customWakeAt("2026-09-22T10:00", now), null);
  assert.equal(api.customWakeAt("not a date", now), null);
  assert.equal(api.customWakeAt("2026-09-22T10:05", now), local(2026, 9, 22, 10, 5).getTime());
  assert.equal(api.dateTimeValue(local(2026, 3, 4, 7, 5)), "2026-03-04T07:05");
});

test("the clock never sleeps longer than a minute", () => {
  assert.equal(api.nextDelay(null, 1000), 60_000);
  assert.equal(api.nextDelay(500, 1000), 0);
  assert.equal(api.nextDelay(31_000, 1000), 30_000);
  assert.equal(api.nextDelay(10_000_000, 1000), 60_000);
});

test("wake labels read naturally", () => {
  const now = local(2026, 9, 22, 10, 0).getTime();
  assert.match(api.wakeLabel(local(2026, 9, 23, 9).getTime(), now), /^tomorrow 9:00\sAM$/u);
  assert.match(api.wakeLabel(local(2026, 9, 26, 9).getTime(), now), /^Sat 9:00\sAM$/u);
  assert.match(api.wakeLabel(local(2026, 10, 3, 9).getTime(), now), /^Oct 3, 9:00\sAM$/u);
});
```

`tests/sweep.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const api = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/sweep.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: api });
const DAY = 86_400_000;
const now = 1_800_000_000_000;
const tab = (id, daysAgo) => ({ id, url: `https://${id}.example/`, title: id, status: "hibernated", groupId: "1", lastUsedAt: now - daysAgo * DAY });

test("stale tabs are the untouched ones, oldest first", () => {
  const tabs = [tab("a", 30), tab("b", 2), tab("c", 45), tab("d", 22)];
  assert.deepEqual(api.staleTabs(tabs, null, null, now, 21).map((t) => t.id), ["c", "a", "d"]);
});

test("the active tab and its split partner are never stale", () => {
  const tabs = [tab("a", 30), tab("b", 30), tab("c", 30)];
  assert.deepEqual(api.staleTabs(tabs, "a", "b", now, 21).map((t) => t.id), ["c"]);
});

test("off means nothing is ever stale", () => {
  assert.deepEqual(api.staleTabs([tab("a", 400)], null, null, now, 0), []);
});

test("suggest only with enough stale tabs and outside the cooldown", () => {
  const three = [tab("a", 30), tab("b", 30), tab("c", 30)];
  assert.equal(api.shouldSuggest(three.slice(0, 2), 0, now), false);
  assert.equal(api.shouldSuggest(three, 0, now), true);
  assert.equal(api.shouldSuggest(three, now + 1, now), false);
  assert.equal(api.shouldSuggest(three, now, now), true);
  assert.equal(api.DISMISS_FOR, 7 * DAY);
  assert.deepEqual([...api.SWEEP_CHOICES], [0, 7, 21, 30]);
  assert.deepEqual([0, 7, 21, 30].map(api.sweepChoiceLabel), ["Off", "1 week", "3 weeks", "1 month"]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/snooze.test.mjs tests/sweep.test.mjs`
Expected: FAIL with ENOENT for `src/lib/snooze.ts` and `src/lib/sweep.ts`.

- [ ] **Step 3: Implement `src/lib/snooze.ts`**

```ts
export type PresetId = "hour" | "evening" | "tomorrow" | "weekend" | "week";
export interface SnoozePreset { id: PresetId; label: string; detail: string; at: number }

const MINUTE = 60_000;
const DAY = 86_400_000;

/** `base`'s calendar day moved by `days`, at `hour`:00 local. Local-field
 *  setters, so month ends and DST land on the wall-clock hour asked for. */
function dayAt(base: Date, days: number, hour: number): Date {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Days until the next `weekday` strictly after today (0 = Sunday). */
function daysUntil(today: number, weekday: number): number {
  const n = (weekday - today + 7) % 7;
  return n === 0 ? 7 : n;
}

export function snoozePresets(now: Date): SnoozePreset[] {
  const late = now.getHours() >= 17;
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  const presets: Omit<SnoozePreset, "detail">[] = [
    { id: "hour", label: "In 1 hour", at: now.getTime() + 60 * MINUTE },
    { id: "evening", label: late ? "Tomorrow evening" : "This evening", at: dayAt(now, late ? 1 : 0, 18).getTime() },
    { id: "tomorrow", label: "Tomorrow morning", at: dayAt(now, 1, 9).getTime() },
    { id: "weekend", label: weekend ? "Next weekend" : "This weekend", at: dayAt(now, daysUntil(now.getDay(), 6), 9).getTime() },
    { id: "week", label: "Next week", at: dayAt(now, daysUntil(now.getDay(), 1), 9).getTime() },
  ];
  return presets.map((p) => ({ ...p, detail: wakeLabel(p.at, now.getTime()) }));
}

/** A `datetime-local` value as a wake time, or null unless it's at least a
 *  minute from now. */
export function customWakeAt(value: string, now: number): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) && at >= now + MINUTE ? at : null;
}

export function dateTimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** How long the wake clock sleeps. Capped at a minute so a laptop that
 *  slept through a wake time catches up soon after it opens. */
export function nextDelay(nextWakeAt: number | null, now: number): number {
  if (nextWakeAt === null) return MINUTE;
  return Math.min(Math.max(nextWakeAt - now, 0), MINUTE);
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function wakeLabel(at: number, now: number): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days > 1 && days < 7) return `${when.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return `${when.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}
```

- [ ] **Step 4: Implement `src/lib/sweep.ts`**

```ts
import type { Tab } from "./tabs";

export const DAY = 86_400_000;
export const SWEEP_CHOICES = [0, 7, 21, 30] as const;
export const DEFAULT_SWEEP_DAYS = 21;
export const DISMISS_FOR = 7 * DAY;
/** Fewer than this isn't a pile worth interrupting anyone about. */
export const MIN_STALE = 3;

/** Tabs untouched for `thresholdDays` or more, oldest first. What's on
 *  screen is never stale, however long it has sat there. */
export function staleTabs(tabs: Tab[], activeId: string | null, splitId: string | null, now: number, thresholdDays: number): Tab[] {
  if (thresholdDays <= 0) return [];
  const cutoff = now - thresholdDays * DAY;
  return tabs
    .filter((t) => t.id !== activeId && t.id !== splitId && t.lastUsedAt < cutoff)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
}

export function shouldSuggest(stale: Tab[], dismissedUntil: number, now: number): boolean {
  return stale.length >= MIN_STALE && now >= dismissedUntil;
}

export function sweepChoiceLabel(days: number): string {
  return days === 0 ? "Off" : days === 7 ? "1 week" : days === 30 ? "1 month" : `${days / 7} weeks`;
}
```

In `src/lib/tabs.ts`, add to `interface Tab`, after `groupId`:

```ts
  /** Wall-clock ms the tab was last on screen. Survives restarts. */
  lastUsedAt: number;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/snooze.test.mjs tests/sweep.test.mjs`
Expected: all 11 PASS.

- [ ] **Step 6: Full suite, build, commit**

Run: `npm test && npm run build`
Expected: pass. If `tsc` complains that some literal `Tab` object lacks `lastUsedAt`, add `lastUsedAt: Date.now()` there. `grep -rn "groupId:" src` finds them.

```bash
git add src/lib/snooze.ts src/lib/sweep.ts src/lib/tabs.ts tests/snooze.test.mjs tests/sweep.test.mjs
git commit -m "feat: work out snooze times and which tabs have gone stale"
```

---

### Task 2: The `snoozed` table

**Files:**
- Create: `src-tauri/migrations/006_snoozed.sql` and `src/lib/snooze-db.ts`
- Modify: `src-tauri/src/lib.rs` (add migration 6 after migration 5, ~line 70)
- Test: `tests/snooze-db.test.mjs`

**Interfaces:**
- Produces:
  - `interface SnoozedTab { id: number; url: string; title: string; spaceId: string | null; spaceName: string | null; wakeAt: number; snoozedAt: number }`
  - `addSnooze(input: { url: string; title: string; spaceId: string | null; spaceName: string | null; wakeAt: number }): Promise<void>`
  - `dueSnoozes(now: number): Promise<SnoozedTab[]>`
  - `listSnoozes(): Promise<SnoozedTab[]>`
  - `nextWakeAt(): Promise<number | null>`
  - `deleteSnooze(id: number): Promise<void>`

- [ ] **Step 1: Write the failing test**, `tests/snooze-db.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const now = 1_800_000_000_000;
function setup() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../src-tauri/migrations/006_snoozed.sql", import.meta.url), "utf8"));
  const bind = (values = []) => Object.fromEntries(values.map((v, i) => [`$${i + 1}`, v]));
  const adapter = {
    async execute(query, values) { return sql.prepare(query).run(bind(values)); },
    async select(query, values) { return sql.prepare(query).all(bind(values)); },
  };
  const api = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/snooze-db.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports: api, Date: class extends Date { static now() { return now; } },
    require(name) { assert.equal(name, "@tauri-apps/plugin-sql"); return { __esModule: true, default: { get: () => adapter } }; },
  });
  return { api, sql };
}
const row = (url, wakeAt) => ({ url, title: url.slice(8), spaceId: "1", spaceName: "Space 1", wakeAt });

test("due rows are the ones whose time has come, soonest first", async () => {
  const { api } = setup();
  await api.addSnooze(row("https://later.example/", now + 60_000));
  await api.addSnooze(row("https://b.example/", now - 1_000));
  await api.addSnooze(row("https://a.example/", now - 5_000));
  const due = await api.dueSnoozes(now);
  assert.deepEqual(due.map((r) => r.url), ["https://a.example/", "https://b.example/"]);
  assert.equal(due[0].spaceName, "Space 1");
  assert.equal(due[0].snoozedAt, now);
  assert.equal(await api.nextWakeAt(), now - 5_000);
});

test("list, delete, and an empty table", async () => {
  const { api } = setup();
  assert.equal(await api.nextWakeAt(), null);
  await api.addSnooze(row("https://x.example/", now + 10));
  await api.addSnooze(row("https://y.example/", now + 5));
  const all = await api.listSnoozes();
  assert.deepEqual(all.map((r) => r.url), ["https://y.example/", "https://x.example/"]);
  await api.deleteSnooze(all[0].id);
  assert.deepEqual((await api.listSnoozes()).map((r) => r.url), ["https://x.example/"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/snooze-db.test.mjs`
Expected: FAIL with ENOENT for `006_snoozed.sql`.

- [ ] **Step 3: Implement**

`src-tauri/migrations/006_snoozed.sql`:

```sql
CREATE TABLE snoozed (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  space_id TEXT,
  space_name TEXT,
  wake_at INTEGER NOT NULL,
  snoozed_at INTEGER NOT NULL
);
CREATE INDEX idx_snoozed_wake ON snoozed(wake_at);
```

In `src-tauri/src/lib.rs` `migrations()`, after the version 5 entry:

```rust
        Migration {
            version: 6,
            description: "snoozed tabs",
            sql: include_str!("../migrations/006_snoozed.sql"),
            kind: MigrationKind::Up,
        },
```

`src/lib/snooze-db.ts`:

```ts
import Database from "@tauri-apps/plugin-sql";

const db = Database.get("sqlite:twig.db");

export interface SnoozedTab {
  id: number;
  url: string;
  title: string;
  spaceId: string | null;
  spaceName: string | null;
  wakeAt: number;
  snoozedAt: number;
}

const columns = `id, url, title, space_id AS spaceId, space_name AS spaceName,
  wake_at AS wakeAt, snoozed_at AS snoozedAt`;

export async function addSnooze(input: { url: string; title: string; spaceId: string | null; spaceName: string | null; wakeAt: number }): Promise<void> {
  await db.execute(
    `INSERT INTO snoozed (url, title, space_id, space_name, wake_at, snoozed_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.url, input.title, input.spaceId, input.spaceName, input.wakeAt, Date.now()],
  );
}

export function dueSnoozes(now: number): Promise<SnoozedTab[]> {
  return db.select<SnoozedTab[]>(`SELECT ${columns} FROM snoozed WHERE wake_at <= $1 ORDER BY wake_at, id`, [now]);
}

export function listSnoozes(): Promise<SnoozedTab[]> {
  return db.select<SnoozedTab[]>(`SELECT ${columns} FROM snoozed ORDER BY wake_at, id`);
}

export async function nextWakeAt(): Promise<number | null> {
  const rows = await db.select<{ n: number | null }[]>("SELECT MIN(wake_at) AS n FROM snoozed");
  return rows[0]?.n ?? null;
}

export async function deleteSnooze(id: number): Promise<void> {
  await db.execute("DELETE FROM snoozed WHERE id = $1", [id]);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/snooze-db.test.mjs`
Expected: 2 PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm test && npm run build && (cd src-tauri && cargo check)`

```bash
git add src-tauri/migrations/006_snoozed.sql src-tauri/src/lib.rs src/lib/snooze-db.ts tests/snooze-db.test.mjs
git commit -m "feat: keep snoozed tabs in their own table"
```

---

### Task 3: Rust: last-used time, background tabs, the shortcut

**Files:**
- Modify: `src-tauri/src/tabs.rs`:
  - imports (line 5)
  - `TabInfo` (~320) and `TabEntry` (~405) plus `to_info`
  - `wake` (~975)
  - `open_tab_with_script` (~1116)
  - `navigate` (~1471)
  - `PersistedTab` (~2122), `save_session` and `restore_session`
  - a new `wall_ms`, `landing_group` and `open_background_tab`
  - a new test module
- Modify: `src-tauri/src/tabs/checkpoints.rs`, `tabs/recall.rs` and `tabs/research.rs` (every `TabEntry {` literal)
- Modify: `src-tauri/src/lib.rs` (register the command) and `src-tauri/src/keymap.rs` (the action)
- Modify: `src/lib/tabs.ts` (the `openBackgroundTab` wrapper)

**Interfaces:**
- Produces:
  - Tauri command `open_background_tab { url: String, title: String, group_id: Option<String> } -> TabInfo`;
  - `TabInfo.lastUsedAt` (ms) on every `tabs-changed`;
  - TS `openBackgroundTab(url: string, title: string, groupId: string | null): Promise<Tab>`;
  - menu action `"snooze-tab"`.

- [ ] **Step 1: Write the failing Rust tests** (append to `src-tauri/src/tabs.rs`)

```rust
#[cfg(test)]
mod snooze_tests {
    use super::{landing_group, Group, PersistedTab};

    fn group(id: &str) -> Group {
        Group { id: id.into(), name: id.into(), active_id: None, split_id: None, checkpoint_parent_id: None }
    }

    #[test]
    fn sessions_saved_before_last_used_existed_still_load() {
        let tab: PersistedTab = serde_json::from_str(
            r#"{"id":"1","url":"https://a.example/","title":"A","scroll_y":0.0,"group_id":"1"}"#,
        )
        .unwrap();
        assert!(tab.last_used_ms.is_none());
    }

    #[test]
    fn woken_tabs_go_home_or_to_the_current_space() {
        let groups = vec![group("1"), group("2")];
        assert_eq!(landing_group(&groups, Some("2"), "1"), "2");
        assert_eq!(landing_group(&groups, Some("gone"), "1"), "1");
        assert_eq!(landing_group(&groups, None, "1"), "1");
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src-tauri && cargo test snooze_tests 2>&1 | tail -5`
Expected: compile errors, `no field last_used_ms` and `cannot find function landing_group`.

- [ ] **Step 3: Implement the last-used time**

- Line 5: `use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};`
- Near the other helpers (above `content_area`), add:

```rust
/// Wall-clock milliseconds. `Instant` can't survive a restart, and "untouched
/// for three weeks" has to.
pub(crate) fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
```

- `TabInfo`: add `pub last_used_at: u64,` after `group_id`.
- `TabEntry`: add `/// Wall-clock ms this tab was last on screen, persisted for the sweep.` and `last_used_ms: u64,` after `last_active_at`.
- `to_info`: add `last_used_at: self.last_used_ms,`.
- In `wake` (after `entry.last_active_at = Instant::now();` ~975) and in `navigate` (~1471), add `entry.last_used_ms = wall_ms();`.
- Give every non-test `TabEntry { … }` literal `last_used_ms: wall_ms(),` (from `grep -rn "TabEntry {" src-tauri/src`):
  - `tabs.rs` ~1116
  - `checkpoints.rs` ~325
  - `research.rs` ~608
  - In the submodules, write it as `last_used_ms: super::wall_ms(),`.
- Give the literals inside `#[cfg(test)]` modules (`checkpoints.rs` ~440, `recall.rs` ~186, `research.rs` ~914) `last_used_ms: 0,`. Before editing, confirm each line number sits inside a `#[cfg(test)]` block.
- `PersistedTab`: add

```rust
    /// Absent in sessions saved before the sweep existed; those tabs count
    /// as used at restore, so nobody is told to archive their whole session.
    #[serde(default)]
    last_used_ms: Option<u64>,
```

- `save_session` map: add `last_used_ms: Some(t.last_used_ms),`.
- `restore_session` map (~2224): add `last_used_ms: t.last_used_ms.unwrap_or_else(wall_ms),`.

- [ ] **Step 4: Implement the background open** (after `create_tab`)

```rust
/// The space a background tab should land in: the one it came from, if it
/// still exists, otherwise whichever space you're in now.
fn landing_group(groups: &[Group], requested: Option<&str>, active: &str) -> String {
    requested
        .filter(|id| groups.iter().any(|g| g.id == *id))
        .unwrap_or(active)
        .to_string()
}

/// Puts a page back in the strip without showing it: asleep, no webview,
/// focus and the current space untouched. How snoozed tabs come home.
#[tauri::command]
pub fn open_background_tab<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    manager: State<'_, TabManager>,
    url: String,
    title: String,
    group_id: Option<String>,
) -> Result<TabInfo, String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only web pages can be reopened".into());
    }
    let mut managers = manager.0.lock().unwrap();
    let inner = inner_for(&mut managers, &window);
    let group_id = landing_group(&inner.groups, group_id.as_deref(), &inner.active_group_id);
    let id = (NEXT_TAB_ID.fetch_add(1, Ordering::Relaxed) + 1).to_string();
    let title = if title.trim().is_empty() { derive_title(&parsed) } else { title };
    inner.tabs.push(TabEntry {
        id: id.clone(),
        url: parsed.to_string(),
        title,
        status: TabStatus::Hibernated,
        last_active_at: Instant::now(),
        last_used_ms: wall_ms(),
        scroll_y: 0.0,
        group_id,
    });
    let info = inner.tabs.last().map(TabEntry::to_info).expect("tab was just pushed");
    emit_tabs_changed(&app, window.label(), inner);
    Ok(info)
}
```

Register `tabs::open_background_tab,` after `tabs::set_content_inset,` in `lib.rs`. In `keymap.rs`, after `prev-tab`, add:

```rust
    a("snooze-tab", "Snooze Tab…", "Tab", "CmdOrCtrl+Alt+S", true),
```

In `src/lib/tabs.ts`, after `createTab`, add:

```ts
/** Reopens a page asleep in `groupId` (or the current space if that's
 *  gone) without switching to it. */
export function openBackgroundTab(url: string, title: string, groupId: string | null): Promise<Tab> {
  return invoke("open_background_tab", { url, title, groupId });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test 2>&1 | grep -E "test result|FAILED|panicked"`
Expected: every `test result: ok`, including the 2 new snooze tests.

- [ ] **Step 6: Verify and commit**

Run: `npm test && npm run build`

```bash
git add src-tauri/src/tabs.rs src-tauri/src/tabs/checkpoints.rs src-tauri/src/tabs/recall.rs src-tauri/src/tabs/research.rs src-tauri/src/lib.rs src-tauri/src/keymap.rs src/lib/tabs.ts
git commit -m "feat: remember when each tab was last used, and reopen tabs in the background"
```

---

### Task 4: Snooze state, actions, and the wake clock

**Files:**
- Create: `src/store/snooze.ts`, `src/lib/snooze-actions.ts` and `src/lib/use-stale-tabs.ts`
- Modify: `src/App.tsx` (two effects)
- Test: `tests/snooze-store.test.mjs`

**Interfaces:**
- Consumes:
  - `nextDelay` (Task 1);
  - `DEFAULT_SWEEP_DAYS`, `DISMISS_FOR`, `SWEEP_CHOICES`, `staleTabs` (Task 1);
  - `addSnooze`, `deleteSnooze`, `dueSnoozes`, `nextWakeAt`, `SnoozedTab` (Task 2);
  - `openBackgroundTab` (Task 3);
  - `closeTab`, `isInternalUrl`, `archiveTab`, `useTabStore` (existing).
- Produces:
  - `useSnoozeStore` with state `{ pickerFor: string | null; woken: Record<string, true>; sweepOpen: boolean; sweepDays: number; dismissedUntil: number }` and actions `openPicker(id)`, `closePicker()`, `markWoken(id)`, `seen(id)`, `setSweepDays(days)`, `dismiss(now)`, `openSweep()`, `closeSweep()`
  - `canSnooze(tabId: string | null): boolean`
  - `snoozeTab(tabId: string, wakeAt: number): Promise<void>`
  - `wakeDue(now?: number): Promise<void>`
  - `wakeNow(row: SnoozedTab): Promise<void>`
  - `cancelSnooze(row: SnoozedTab): Promise<void>`
  - `startSnoozeClock(): () => void`
  - `watchWoken(): () => void`
  - `useStaleTabs(): Tab[]`

- [ ] **Step 1: Write the failing store test**, `tests/snooze-store.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sweep = {};
runInNewContext(compile("../src/lib/sweep.ts"), { exports: sweep });
const DAY = 86_400_000;

function load(initial = {}) {
  const items = new Map(Object.entries(initial));
  const localStorage = { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v) };
  const exports = {};
  runInNewContext(compile("../src/store/snooze.ts"), {
    exports, localStorage, Number,
    require(name) {
      if (name === "zustand") return require("zustand");
      assert.equal(name, "../lib/sweep");
      return sweep;
    },
  });
  return { store: exports.useSnoozeStore, items };
}

test("sweep threshold defaults to three weeks and persists", () => {
  const { store, items } = load();
  assert.equal(store.getState().sweepDays, 21);
  store.getState().setSweepDays(7);
  assert.equal(items.get("twig:sweep-days"), "7");
  assert.equal(load({ "twig:sweep-days": "7" }).store.getState().sweepDays, 7);
  assert.equal(load({ "twig:sweep-days": "0" }).store.getState().sweepDays, 0);
  assert.equal(load({ "twig:sweep-days": "13" }).store.getState().sweepDays, 21);
  assert.equal(load({ "twig:sweep-days": "junk" }).store.getState().sweepDays, 21);
});

test("not now hides the suggestion for a week and survives restarts", () => {
  const { store, items } = load();
  store.getState().openSweep();
  store.getState().dismiss(1000);
  assert.equal(store.getState().dismissedUntil, 1000 + 7 * DAY);
  assert.equal(store.getState().sweepOpen, false);
  assert.equal(items.get("twig:sweep-dismissed-until"), String(1000 + 7 * DAY));
  assert.equal(load({ "twig:sweep-dismissed-until": "42" }).store.getState().dismissedUntil, 42);
  assert.equal(load({ "twig:sweep-dismissed-until": "x" }).store.getState().dismissedUntil, 0);
});

test("woken marks clear once seen, and the picker tracks one tab", () => {
  const { store } = load();
  store.getState().markWoken("9");
  assert.deepEqual({ ...store.getState().woken }, { 9: true });
  store.getState().seen("9");
  assert.deepEqual({ ...store.getState().woken }, {});
  store.getState().openPicker("3");
  assert.equal(store.getState().pickerFor, "3");
  store.getState().closePicker();
  assert.equal(store.getState().pickerFor, null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/snooze-store.test.mjs`
Expected: FAIL with ENOENT for `src/store/snooze.ts`.

- [ ] **Step 3: Implement `src/store/snooze.ts`**

```ts
import { create } from "zustand";
import { DEFAULT_SWEEP_DAYS, DISMISS_FOR, SWEEP_CHOICES } from "../lib/sweep";

const DAYS_KEY = "twig:sweep-days";
const DISMISS_KEY = "twig:sweep-dismissed-until";

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: lasts this session */ }
}
function loadDays(): number {
  const raw = read(DAYS_KEY);
  const days = Number(raw);
  return raw !== null && (SWEEP_CHOICES as readonly number[]).includes(days) ? days : DEFAULT_SWEEP_DAYS;
}
function loadDismissed(): number {
  const until = Number(read(DISMISS_KEY));
  return Number.isFinite(until) ? until : 0;
}

interface SnoozeStore {
  /** Tab whose snooze picker is open. */
  pickerFor: string | null;
  /** Tabs that came back from a snooze and haven't been looked at yet. */
  woken: Record<string, true>;
  sweepOpen: boolean;
  sweepDays: number;
  dismissedUntil: number;
  openPicker: (id: string) => void;
  closePicker: () => void;
  markWoken: (id: string) => void;
  seen: (id: string) => void;
  setSweepDays: (days: number) => void;
  dismiss: (now: number) => void;
  openSweep: () => void;
  closeSweep: () => void;
}

export const useSnoozeStore = create<SnoozeStore>((set, get) => ({
  pickerFor: null,
  woken: {},
  sweepOpen: false,
  sweepDays: loadDays(),
  dismissedUntil: loadDismissed(),
  openPicker: (id) => set({ pickerFor: id }),
  closePicker: () => set({ pickerFor: null }),
  markWoken: (id) => set((s) => ({ woken: { ...s.woken, [id]: true } })),
  seen: (id) => {
    if (!get().woken[id]) return;
    set((s) => {
      const woken = { ...s.woken };
      delete woken[id];
      return { woken };
    });
  },
  setSweepDays: (days) => {
    write(DAYS_KEY, String(days));
    set({ sweepDays: days });
  },
  dismiss: (now) => {
    const until = now + DISMISS_FOR;
    write(DISMISS_KEY, String(until));
    set({ dismissedUntil: until, sweepOpen: false });
  },
  openSweep: () => set({ sweepOpen: true }),
  closeSweep: () => set({ sweepOpen: false }),
}));
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/snooze-store.test.mjs`
Expected: 3 PASS.

- [ ] **Step 5: Implement `src/lib/snooze-actions.ts`**

```ts
import { getCurrentWindow } from "@tauri-apps/api/window";
import { addSnooze, deleteSnooze, dueSnoozes, nextWakeAt, type SnoozedTab } from "./snooze-db";
import { archiveTab } from "./db";
import { closeTab, isInternalUrl, openBackgroundTab } from "./tabs";
import { nextDelay } from "./snooze";
import { useTabStore } from "../store/tabs";
import { useSnoozeStore } from "../store/snooze";

const MAX_FAILURES = 3;
const failures = new Map<number, number>();

function changed() {
  window.dispatchEvent(new Event("twig:snoozed-changed"));
}

export function canSnooze(tabId: string | null): boolean {
  const s = useTabStore.getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  return !!tab && !s.isPrivate && !isInternalUrl(tab.url) && /^https?:/.test(tab.url);
}

/** Closes the tab - without sending it to Closed tabs - once its return
 *  is written down. If the write fails the tab stays open. */
export async function snoozeTab(tabId: string, wakeAt: number): Promise<void> {
  const s = useTabStore.getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab || !canSnooze(tabId)) throw new Error("This tab can't be snoozed.");
  if (!(wakeAt > Date.now())) throw new Error("Pick a time in the future.");
  const space = s.groups.find((g) => g.id === tab.groupId);
  await addSnooze({ url: tab.url, title: tab.title, spaceId: tab.groupId, spaceName: space?.name ?? null, wakeAt });
  changed();
  await closeTab(tabId);
}

export async function wakeDue(now = Date.now()): Promise<void> {
  let touched = false;
  for (const row of await dueSnoozes(now)) {
    try {
      const tab = await openBackgroundTab(row.url, row.title, row.spaceId);
      await deleteSnooze(row.id);
      failures.delete(row.id);
      useSnoozeStore.getState().markWoken(tab.id);
      touched = true;
    } catch (cause) {
      const count = (failures.get(row.id) ?? 0) + 1;
      failures.set(row.id, count);
      console.warn("Couldn't bring back a snoozed tab", row.url, cause);
      if (count >= MAX_FAILURES) {
        // Give up on reopening, but never lose it: it's in Closed tabs now.
        await archiveTab(row.url, row.title).catch(() => {});
        await deleteSnooze(row.id).catch(() => {});
        failures.delete(row.id);
        touched = true;
      }
    }
  }
  if (touched) changed();
}

export async function wakeNow(row: SnoozedTab): Promise<void> {
  const tab = await openBackgroundTab(row.url, row.title, row.spaceId);
  await deleteSnooze(row.id);
  changed();
  await useTabStore.getState().switchTo(tab.id);
}

/** Not coming back after all - but still findable, in Closed tabs. */
export async function cancelSnooze(row: SnoozedTab): Promise<void> {
  await archiveTab(row.url, row.title);
  await deleteSnooze(row.id);
  changed();
}

/** Wakes due tabs now, then again whenever the next one is due - never
 *  sleeping over a minute, never faster than a second. Main window only,
 *  so a private window can't bring a tab back twice. */
export function startSnoozeClock(): () => void {
  if (getCurrentWindow().label !== "main") return () => {};
  let timer: number | undefined;
  let running = false;
  let stopped = false;
  async function tick() {
    if (running || stopped) return;
    running = true;
    window.clearTimeout(timer);
    try { await wakeDue(); } catch (cause) { console.warn("Snooze clock failed", cause); }
    let next: number | null = null;
    try { next = await nextWakeAt(); } catch { /* retry on the next tick */ }
    running = false;
    if (!stopped) timer = window.setTimeout(tick, Math.max(1000, nextDelay(next, Date.now())));
  }
  const kick = () => void tick();
  window.addEventListener("focus", kick);
  window.addEventListener("twig:snoozed-changed", kick);
  kick();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.removeEventListener("focus", kick);
    window.removeEventListener("twig:snoozed-changed", kick);
  };
}

/** A woken tab's dot goes once you've looked at it. */
export function watchWoken(): () => void {
  return useTabStore.subscribe((s) => {
    if (s.activeId && useSnoozeStore.getState().woken[s.activeId]) useSnoozeStore.getState().seen(s.activeId);
  });
}
```

`src/lib/use-stale-tabs.ts`:

```ts
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTabStore } from "../store/tabs";
import { useSnoozeStore } from "../store/snooze";
import { staleTabs } from "./sweep";
import type { Tab } from "./tabs";

/** Tabs worth offering to archive, re-checked hourly and on every change. */
export function useStaleTabs(): Tab[] {
  const { tabs, activeId, splitId, isPrivate } = useTabStore(
    useShallow((s) => ({ tabs: s.tabs, activeId: s.activeId, splitId: s.splitId, isPrivate: s.isPrivate })),
  );
  const days = useSnoozeStore((s) => s.sweepDays);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 3_600_000);
    return () => window.clearInterval(timer);
  }, []);
  return useMemo(
    () => (isPrivate ? [] : staleTabs(tabs, activeId, splitId, now, days)),
    [tabs, activeId, splitId, now, days, isPrivate],
  );
}
```

In `src/App.tsx`, add `import { startSnoozeClock, watchWoken } from "./lib/snooze-actions";`, and next to `useEffect(() => watchChanges(), []);` add:

```ts
  useEffect(() => startSnoozeClock(), []);
  useEffect(() => watchWoken(), []);
```

- [ ] **Step 6: Verify and commit**

Run: `npm test && npm run build`
Expected: pass.

```bash
git add src/store/snooze.ts src/lib/snooze-actions.ts src/lib/use-stale-tabs.ts src/App.tsx tests/snooze-store.test.mjs
git commit -m "feat: snooze tabs and bring them back when their time comes"
```

---

### Task 5: The UI: moon button, picker, pill, review panel, Library, Settings, palette

**Files:**
- Create: `src/components/SnoozePicker.tsx` + `.css`, and `src/components/SweepPanel.tsx` + `.css`
- Modify:
  - `src/components/Icon.tsx` (the `moon` icon)
  - `src/components/TabStrip.tsx` + `.css`
  - `src/components/Library.tsx`
  - `src/components/SettingsPanel.tsx`
  - `src/components/CommandPalette.tsx`
  - `src/components/Changes.tsx` (one line: mutual exclusion)
  - `src/App.tsx` (render both components)

**Interfaces:**
- Consumes Tasks 1–4 as listed there, plus `useChangeStore` and `setContentInset`.
- Produces the DOM contract for Task 6:
  - `button.tab-snooze` (aria-label "Snooze tab"), `span.tab-woke`, and `button.sweep-pill` with text `N untouched tabs`;
  - the dialog `dialog.snooze`, with the accessible name "Snooze until…", options `li[role=option]`, and keys 1–6;
  - the panel `aside[aria-label="Untouched tabs"]`, with buttons named `/^Archive \d+ tabs?$/`, "Snooze to next week" and "Not now";
  - the Library segment button "Snoozed", with rows whose meta starts "Wakes", and a cancel button named "Cancel snooze".

- [ ] **Step 1: Add the moon icon** (`Icon.tsx`). Add `| "moon"` to `IconName`, and to `PATHS`:

```tsx
  moon: <path d="M12.8 10.4A5.2 5.2 0 0 1 5.6 3.2a5.2 5.2 0 1 0 7.2 7.2Z" />,
```

- [ ] **Step 2: Update the tab strip** (`TabStrip.tsx`)
- Add `isPrivate` to the destructured `useTabStore()` fields.
- Imports:

```tsx
import { useSnoozeStore } from "../store/snooze";
import { useStaleTabs } from "../lib/use-stale-tabs";
import { shouldSuggest } from "../lib/sweep";
```

- Inside the component:

```tsx
  const woken = useSnoozeStore((s) => s.woken);
  const openPicker = useSnoozeStore((s) => s.openPicker);
```

- Directly after the `tab-dot` span:

```tsx
            {woken[tab.id] && <span className="tab-woke" title="Back from snooze" aria-label="Back from snooze" />}
```

- Between the split and close buttons:

```tsx
            {!isPrivate && /^https?:/.test(tab.url) && (
              <button
                className="tab-action tab-snooze"
                title="Snooze (⌥⌘S)"
                aria-label="Snooze tab"
                onClick={(e) => {
                  e.stopPropagation();
                  openPicker(tab.id);
                }}
              >
                <Icon name="moon" size={13} />
              </button>
            )}
```

- Before the `tab-new` button: `<SweepPill />`. Define it below `TabStrip` in the same file:

```tsx
function SweepPill() {
  const stale = useStaleTabs();
  const dismissedUntil = useSnoozeStore((s) => s.dismissedUntil);
  const openSweep = useSnoozeStore((s) => s.openSweep);
  if (!shouldSuggest(stale, dismissedUntil, Date.now())) return null;
  return (
    <button className="sweep-pill" title="Review tabs you haven't touched" onClick={openSweep}>
      {stale.length} untouched tabs
    </button>
  );
}
```

- Append to `TabStrip.css`:

```css
.tab-woke { flex-shrink: 0; width: 6px; height: 6px; margin-left: -2px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--accent-tint); }
.sweep-pill { flex-shrink: 0; align-self: center; height: 24px; margin-right: 6px; padding: 0 10px; border: 0; border-radius: 999px; background: var(--accent-tint); color: var(--text); font: inherit; font-size: 11.5px; font-weight: 550; white-space: nowrap; cursor: default; transition: background-color 160ms var(--ease); }
.sweep-pill:hover { background: color-mix(in srgb, var(--accent) 22%, var(--surface)); }
.sweep-pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

- [ ] **Step 3: Create `SnoozePicker.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useTabStore } from "../store/tabs";
import { useSnoozeStore } from "../store/snooze";
import { customWakeAt, dateTimeValue, snoozePresets } from "../lib/snooze";
import { canSnooze, snoozeTab } from "../lib/snooze-actions";
import { setOverlayActive } from "../lib/tabs";
import { useMenuAction } from "../lib/menu";
import "./SnoozePicker.css";

export function SnoozePicker() {
  const pickerFor = useSnoozeStore((s) => s.pickerFor);
  useMenuAction(["snooze-tab"], () => {
    const id = useTabStore.getState().activeId;
    if (id && canSnooze(id)) useSnoozeStore.getState().openPicker(id);
  });
  return pickerFor ? <Picker key={pickerFor} tabId={pickerFor} /> : null;
}

function Picker({ tabId }: { tabId: string }) {
  const close = useSnoozeStore((s) => s.closePicker);
  const title = useTabStore((s) => s.tabs.find((t) => t.id === tabId)?.title ?? "");
  const [now] = useState(() => new Date());
  const presets = useMemo(() => snoozePresets(now), [now]);
  const [selected, setSelected] = useState(0);
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState(() => dateTimeValue(new Date(now.getTime() + 3_600_000)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const count = presets.length + 1;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    dialog?.focus();
    setOverlayActive(true, "snooze").catch(() => {});
    return () => { setOverlayActive(false, "snooze").catch(() => {}); };
  }, []);

  async function choose(at: number) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await snoozeTab(tabId, at);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  function pick(i: number) {
    setSelected(i);
    if (i < presets.length) void choose(presets[i].at);
    else setCustom(true);
  }

  return (
    <dialog
      ref={dialogRef}
      className="snooze"
      aria-labelledby="snooze-heading"
      tabIndex={-1}
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement) return;
        if (e.key === "ArrowDown") { e.preventDefault(); setSelected((i) => (i + 1) % count); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((i) => (i - 1 + count) % count); }
        else if (e.key === "Enter") { e.preventDefault(); pick(selected); }
        else if (/^[1-6]$/.test(e.key)) { e.preventDefault(); pick(Number(e.key) - 1); }
      }}
    >
      <h2 id="snooze-heading">Snooze until…</h2>
      <p className="snooze-tab">{title}</p>
      <ul className="snooze-options" role="listbox" aria-label="When it comes back" aria-activedescendant={`snooze-${selected}`}>
        {presets.map((p, i) => (
          <li key={p.id} id={`snooze-${i}`} role="option" aria-selected={i === selected}
            className={i === selected ? "snooze-option active" : "snooze-option"}
            onMouseMove={() => setSelected(i)} onClick={() => pick(i)}>
            <kbd>{i + 1}</kbd>
            <span className="snooze-label">{p.label}</span>
            <span className="snooze-detail">{p.detail}</span>
          </li>
        ))}
        <li id={`snooze-${presets.length}`} role="option" aria-selected={selected === presets.length}
          className={selected === presets.length ? "snooze-option active" : "snooze-option"}
          onMouseMove={() => setSelected(presets.length)} onClick={() => pick(presets.length)}>
          <kbd>{presets.length + 1}</kbd>
          <span className="snooze-label">Pick a date and time…</span>
        </li>
      </ul>
      {custom && (
        <form className="snooze-custom" onSubmit={(e) => {
          e.preventDefault();
          const at = customWakeAt(value, Date.now());
          if (at === null) setError("Pick a time at least a minute from now.");
          else void choose(at);
        }}>
          <input type="datetime-local" aria-label="Wake at" value={value} autoFocus onChange={(e) => setValue(e.target.value)} />
          <button type="submit" disabled={busy}>Snooze</button>
        </form>
      )}
      {error && <p className="snooze-error" role="alert">{error}</p>}
    </dialog>
  );
}
```

`SnoozePicker.css`:

```css
.snooze { width: min(380px, calc(100vw - 32px)); margin: 110px auto auto; padding: 18px 10px 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); font: inherit; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.18); }
.snooze:focus { outline: none; }
.snooze::backdrop { background: color-mix(in srgb, var(--strip) 70%, transparent); }
.snooze h2 { margin: 0 10px; font-size: 15px; font-weight: 600; }
.snooze-tab { margin: 4px 10px 12px; overflow: hidden; color: var(--text-muted); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.snooze-options { margin: 0; padding: 0; list-style: none; }
.snooze-option { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px; font-size: 13px; cursor: default; }
.snooze-option.active { background: var(--accent-tint); }
.snooze-option kbd { display: inline-grid; place-items: center; width: 18px; height: 18px; border: 1px solid var(--border-strong); border-radius: 4px; color: var(--text-muted); font: inherit; font-size: 10.5px; }
.snooze-label { flex: 1; }
.snooze-detail { color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.snooze-custom { display: flex; gap: 8px; margin: 8px 10px 4px; }
.snooze-custom input { flex: 1; height: 32px; padding: 4px 8px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; font-size: 12px; }
.snooze-custom button { padding: 0 12px; border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent); border-radius: 6px; background: var(--accent-tint); color: var(--text); font: inherit; font-size: 12px; font-weight: 550; }
.snooze-error { margin: 8px 10px 2px; color: var(--text); font-size: 12px; }
:root[data-theme="dark"] .snooze input { color-scheme: dark; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .snooze input { color-scheme: dark; } }
```

- [ ] **Step 4: Create `SweepPanel.tsx`**

```tsx
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
```

`SweepPanel.css`:

```css
.sweep { position: fixed; right: 0; bottom: 0; z-index: 900; display: flex; flex-direction: column; width: 380px; border-left: 1px solid var(--border); background: var(--surface); color: var(--text); animation: sweep-in 220ms var(--ease); }
.sweep.narrow { width: 100%; border-left: 0; }
@keyframes sweep-in { from { transform: translateX(16px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .sweep { animation: none; } }
.sweep :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sweep-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 18px 12px; border-bottom: 1px solid var(--border); }
.sweep h2 { margin: 0; font-size: 15px; font-weight: 600; }
.sweep h2:focus { outline: none; }
.sweep-header p { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.sweep-icon { display: inline-flex; padding: 6px; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted); }
.sweep-icon:hover { background: var(--row-hover); color: var(--text); }
.sweep-list { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px; scrollbar-color: var(--border-strong) transparent; }
.sweep-row { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 8px; }
.sweep-row:hover { background: var(--row-hover); }
.sweep-row input { accent-color: var(--accent); }
.sweep-text { display: flex; flex-direction: column; min-width: 0; }
.sweep-title { overflow: hidden; font-size: 13px; white-space: nowrap; text-overflow: ellipsis; }
.sweep-meta { color: var(--text-muted); font-size: 11.5px; }
.sweep-empty, .sweep-error { margin: 10px 18px; color: var(--text-muted); font-size: 13px; }
.sweep-footer { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 18px 16px; border-top: 1px solid var(--border); }
.sweep-button { min-height: 30px; padding: 6px 11px; border: 1px solid var(--border-strong); border-radius: 7px; background: transparent; color: var(--text); font: inherit; font-size: 12px; }
.sweep-button:hover:not(:disabled) { background: var(--row-hover); }
.sweep-button:disabled { opacity: 0.5; }
.sweep-button.primary { border-color: color-mix(in srgb, var(--accent) 50%, transparent); background: var(--accent-tint); font-weight: 550; }
.sweep-button.quiet { border-color: transparent; color: var(--text-muted); }
```

In `Changes.tsx` `ChangesPanel`'s first `useEffect`, before `headingRef.current?.focus();`, add `useSnoozeStore.getState().closeSweep();` with the import `import { useSnoozeStore } from "../store/snooze";`.

In `App.tsx`, import both components and render `<SnoozePicker />` and `<SweepPanel />` after `<Changes />`.

- [ ] **Step 5: Add the Library shelf** (`Library.tsx`)

- `type Shelf = "bookmarks" | "history" | "archive" | "snoozed";`
- `interface Row` gains `snooze?: SnoozedTab;`
- Imports:

```tsx
import { listSnoozes, type SnoozedTab } from "../lib/snooze-db";
import { cancelSnooze, wakeNow } from "../lib/snooze-actions";
import { wakeLabel } from "../lib/snooze";
```

- In `load`, before the final `else`:

```tsx
    } else if (shelf === "snoozed") {
      if (isPrivate) { setRows([]); return; }
      const q = query.trim().toLowerCase();
      const snoozed = (await listSnoozes()).filter((s) => !q || s.url.toLowerCase().includes(q) || s.title.toLowerCase().includes(q));
      setRows(snoozed.map((s) => ({
        key: `s-${s.id}`, url: s.url, title: s.title || hostOf(s.url),
        meta: `Wakes ${wakeLabel(s.wakeAt, Date.now())}`, snooze: s,
      })));
```

- A refresh effect after the `load` effect:

```tsx
  useEffect(() => {
    if (!open || shelf !== "snoozed") return;
    const refresh = () => void load();
    window.addEventListener("twig:snoozed-changed", refresh);
    return () => window.removeEventListener("twig:snoozed-changed", refresh);
  }, [open, shelf, load]);
```

- `openRow`: `if (row.snooze) { void wakeNow(row.snooze); setOpen(false); return; }` before `newTab(row.url)`.
- `forget`: add `else if (shelf === "snoozed") { const row = rows.find((r) => r.url === url && r.snooze); if (row?.snooze) await cancelSnooze(row.snooze); }` before the history branch. Put the snoozed branch first so it wins.
- A segment after "Closed":

```tsx
            <button
              className={shelf === "snoozed" ? "segment selected" : "segment"}
              disabled={isPrivate}
              onClick={() => setShelf("snoozed")}
            >
              Snoozed
            </button>
```

- Placeholder: `shelf === "snoozed" ? "Search snoozed tabs"`.
- Empty state: `shelf === "snoozed" ? "Nothing snoozed. Snooze a tab from its moon button or ⌥⌘S."`.
- The forget button's title and aria-label for this shelf are both "Cancel snooze". Title: `"Cancel snooze — it moves to Closed tabs"`.

- [ ] **Step 6: Add the Settings row** (`SettingsPanel.tsx`, Memory section, after the "Tabs kept awake" row)

Imports: `import { useSnoozeStore } from "../store/snooze";` and `import { SWEEP_CHOICES, sweepChoiceLabel } from "../lib/sweep";`. Selectors: `const sweepDays = useSnoozeStore((s) => s.sweepDays);` and `const setSweepDays = useSnoozeStore((s) => s.setSweepDays);`. Markup:

```tsx
            <div className="settings-row">
              <span className="settings-label">Suggest archiving tabs untouched for</span>
              <div className="segmented">
                {SWEEP_CHOICES.map((d) => (
                  <button key={d} className={d === sweepDays ? "segment selected" : "segment"} aria-pressed={d === sweepDays} onClick={() => setSweepDays(d)}>
                    {sweepChoiceLabel(d)}
                  </button>
                ))}
              </div>
            </div>
```

- [ ] **Step 7: Add the palette commands** (`CommandPalette.tsx`)

Imports:

```tsx
import { useSnoozeStore } from "../store/snooze";
import { canSnooze } from "../lib/snooze-actions";
import { useStaleTabs } from "../lib/use-stale-tabs";
import { shouldSuggest } from "../lib/sweep";
```

Next to `hasChange`:

```tsx
  const stale = useStaleTabs();
  const dismissedUntil = useSnoozeStore((s) => s.dismissedUntil);
  const suggestSweep = shouldSuggest(stale, dismissedUntil, Date.now());
```

Add `"cmd-snooze": "snooze-tab",` to `COMMAND_MENU_IDS`. Inside `if (!isPrivate) {`, after the `hasChange` block:

```tsx
      if (activeId && canSnooze(activeId)) {
        commands.push({ key: "cmd-snooze", kind: "command", label: "Snooze tab…", icon: "moon", shortcut: "⌥⌘S", run: () => useSnoozeStore.getState().openPicker(activeId) });
      }
      if (suggestSweep) {
        commands.push({ key: "cmd-sweep", kind: "command", label: `Review ${stale.length} untouched tabs`, icon: "history", run: () => useSnoozeStore.getState().openSweep() });
      }
```

Add `suggestSweep` and `stale.length` to the `useMemo` deps. If the palette's item `icon` field is typed as `IconName`, `"moon"` now type-checks.

- [ ] **Step 8: Verify and commit**

Run: `npm test && npm run build`
Expected: pass, with no TS errors.

```bash
git add src/components/Icon.tsx src/components/TabStrip.tsx src/components/TabStrip.css src/components/SnoozePicker.tsx src/components/SnoozePicker.css src/components/SweepPanel.tsx src/components/SweepPanel.css src/components/Library.tsx src/components/SettingsPanel.tsx src/components/CommandPalette.tsx src/components/Changes.tsx src/App.tsx
git commit -m "feat: snooze from the tab strip, and review tabs you haven't touched"
```

---

### Task 6: End to end, docs, push

**Files:**
- Create: `tests/snooze-browser.mjs` and `docs/snooze.md`
- Modify: `README.md`

- [ ] **Step 1: Write `tests/snooze-browser.mjs`**

```js
// Drives snooze and sweep in WebKit against the running Vite dev server,
// with the Tauri bridge mocked and SQLite in memory.
//
//   npm run dev
//   TWIG_PLAYWRIGHT_MODULE=/path/to/playwright CAPTURE=1 node tests/snooze-browser.mjs
const { webkit } = await import(process.env.TWIG_PLAYWRIGHT_MODULE || "playwright");
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const url = process.env.TWIG_TEST_URL || "http://localhost:1420";
const shots = mkdtempSync(join(tmpdir(), "twig-snooze-"));
const capture = !!process.env.CAPTURE;
const DAY = 86_400_000;
const now = Date.now();

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE bookmarks(id INTEGER PRIMARY KEY, url TEXT UNIQUE, title TEXT, created_at INTEGER);
         CREATE TABLE history(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visited_at INTEGER);
         CREATE TABLE archive(id INTEGER PRIMARY KEY, url TEXT, title TEXT, closed_at INTEGER);
         CREATE VIRTUAL TABLE page_text USING fts5(url UNINDEXED, title, body, captured_at UNINDEXED, tokenize='porter unicode61');`);
db.exec(readFileSync(new URL("../src-tauri/migrations/005_recall.sql", import.meta.url), "utf8"));
db.exec(readFileSync(new URL("../src-tauri/migrations/006_snoozed.sql", import.meta.url), "utf8"));
// Due while twig was closed (Review Focus 1), and one that can never reopen (Review Focus 3).
db.prepare("INSERT INTO snoozed (url, title, space_id, space_name, wake_at, snoozed_at) VALUES (?, ?, '1', 'Space 1', ?, ?)")
  .run("https://missed.example/", "Missed while closed", now - 60_000, now - DAY);
db.prepare("INSERT INTO snoozed (url, title, space_id, space_name, wake_at, snoozed_at) VALUES (?, ?, '1', 'Space 1', ?, ?)")
  .run("https://broken.example/", "Broken", now - 60_000, now - DAY);

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

await page.addInitScript(({ now, DAY }) => {
  localStorage.setItem("twig:welcome-done", "1");
  localStorage.setItem("twig:sweep-days", "7");
  const callbacks = new Map();
  const listeners = new Map();
  let next = 1;
  let nextTab = 100;
  window.calls = [];
  const t = (id, url, daysAgo) => ({ id, url, title: url.replace("https://", "").replace(/\/$/, ""), status: "hibernated", groupId: "1", lastUsedAt: now - daysAgo * DAY });
  window.testState = {
    tabs: [
      { ...t("1", "https://docs.example/", 0), status: "hot" },
      t("2", "https://read-later.example/", 1),
      t("3", "https://old-a.example/", 10), t("4", "https://old-b.example/", 12),
      t("5", "https://old-c.example/", 15), t("6", "https://old-d.example/", 30),
    ],
    activeId: "1", splitId: null, groups: [{ id: "1", name: "Space 1" }], activeGroupId: "1", tabStripVisible: true, isPrivate: false,
  };
  const emit = () => window.fireEvent("tabs-changed", structuredClone(window.testState));
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
      if (command === "close_tab") {
        window.testState.tabs = window.testState.tabs.filter((x) => x.id !== args.id);
        emit();
        return null;
      }
      if (command === "activate_tab") {
        window.testState.activeId = args.id;
        const tab = window.testState.tabs.find((x) => x.id === args.id);
        if (tab) { tab.status = "hot"; tab.lastUsedAt = Date.now(); }
        emit();
        return null;
      }
      if (command === "open_background_tab") {
        if (args.url.includes("broken")) throw new Error("webview refused");
        const tab = { id: String(nextTab++), url: args.url, title: args.title, status: "hibernated", groupId: args.groupId ?? "1", lastUsedAt: Date.now() };
        window.testState.tabs.push(tab);
        emit();
        return tab;
      }
      if (command === "get_keymap") return [];
      if (command === "memory_stats") return { footprintKb: 0, processCount: 0, awakeTabs: 0, sleepingTabs: 0, estimatedSavedKb: 0 };
      return null;
    },
  };
}, { now, DAY });

async function shot(name) {
  if (!capture) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}
async function eventually(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail(`timed out waiting for ${what}`);
}
const calls = (name) => page.evaluate((n) => window.calls.filter((c) => c.command === n).map((c) => c.args), name);
const count = (sql, ...v) => db.prepare(sql).get(...v).n;

try {
  await page.goto(url);
  await page.locator(".tab-strip").waitFor();

  // Review Focus 1: a wake that passed while closed fires on launch.
  await eventually(async () => (await calls("open_background_tab")).some((a) => a.url === "https://missed.example/"), "missed wake on launch", 3000);
  const missed = page.locator(".tab", { hasText: "Missed while closed" });
  await missed.waitFor();
  assert.equal(await missed.locator(".tab-woke").count(), 1);

  // Review Focus 3: a tab that can't reopen ends up in Closed tabs after 3 tries.
  await eventually(() => count("SELECT COUNT(*) n FROM archive WHERE url = 'https://broken.example/'") === 1, "broken tab archived");
  assert.equal(count("SELECT COUNT(*) n FROM snoozed WHERE url = 'https://broken.example/'"), 0);
  assert.equal((await calls("open_background_tab")).filter((a) => a.url.includes("broken")).length, 3);

  // Looking at a woken tab clears its dot.
  await missed.click();
  await eventually(async () => (await missed.locator(".tab-woke").count()) === 0, "woke dot cleared");

  // Snooze tab 2 from its moon button.
  const tab2 = page.locator(".tab", { hasText: "read-later.example" });
  await tab2.hover();
  await tab2.getByRole("button", { name: "Snooze tab" }).click();
  const picker = page.getByRole("dialog", { name: "Snooze until…" });
  await picker.waitFor();
  assert.equal(await picker.getByRole("option").count(), 6);
  await shot("1-picker");
  await page.keyboard.press("1");
  await picker.waitFor({ state: "detached" });
  await eventually(() => count("SELECT COUNT(*) n FROM snoozed WHERE url = 'https://read-later.example/'") === 1, "snooze row");
  const wakeAt = db.prepare("SELECT wake_at w FROM snoozed WHERE url = 'https://read-later.example/'").get().w;
  assert.ok(Math.abs(wakeAt - (Date.now() + 3_600_000)) < 60_000, "in 1 hour");
  assert.deepEqual((await calls("close_tab")).map((a) => a.id), ["2"]);
  assert.equal(count("SELECT COUNT(*) n FROM archive WHERE url = 'https://read-later.example/'"), 0, "snooze is not a close-to-archive");

  // It shows on the Snoozed shelf.
  await page.evaluate(() => window.fireEvent("menu-action", "show-bookmarks"));
  await page.getByRole("button", { name: "Snoozed" }).click();
  await page.getByText(/^Wakes /).first().waitFor();
  await shot("2-snoozed-shelf");
  await page.keyboard.press("Escape");

  // Time passes: move the wake into the past and nudge the clock.
  db.prepare("UPDATE snoozed SET wake_at = ? WHERE url = 'https://read-later.example/'").run(Date.now() - 1000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.locator(".tab", { hasText: "read-later.example" }).locator(".tab-woke").waitFor();
  assert.equal(await page.evaluate(() => window.testState.activeId), (await page.evaluate(() => window.testState.tabs.find((t) => t.title === "Missed while closed").id)), "waking must not steal focus");
  assert.equal(count("SELECT COUNT(*) n FROM snoozed"), 0);

  // Sweep: four tabs untouched for 7+ days.
  const pill = page.locator("button.sweep-pill");
  await pill.waitFor();
  assert.equal(await pill.textContent(), "4 untouched tabs");
  await shot("3-pill");
  await pill.click();
  const panel = page.getByRole("complementary", { name: "Untouched tabs" });
  await panel.waitFor();
  assert.equal((await calls("set_content_inset")).at(-1)?.right, 380);
  await shot("4-sweep-panel");
  await panel.getByRole("button", { name: "Archive 4 tabs" }).click();
  await panel.waitFor({ state: "detached" });
  assert.equal(count("SELECT COUNT(*) n FROM archive WHERE url LIKE 'https://old-%'"), 4);
  await pill.waitFor({ state: "detached" });

  // Not now: re-age two tabs plus one more so the pill returns, then dismiss it.
  await page.evaluate(({ DAY }) => {
    for (const tab of window.testState.tabs) if (tab.id !== window.testState.activeId) tab.lastUsedAt = Date.now() - 20 * DAY;
    window.testState.tabs.push({ id: "50", url: "https://another.example/", title: "another", status: "hibernated", groupId: "1", lastUsedAt: Date.now() - 20 * DAY });
    window.fireEvent("tabs-changed", structuredClone(window.testState));
  }, { DAY });
  await pill.waitFor();
  await pill.click();
  await panel.getByRole("button", { name: "Not now" }).click();
  await pill.waitFor({ state: "detached" });
  assert.ok(Number(await page.evaluate(() => localStorage.getItem("twig:sweep-dismissed-until"))) > Date.now() + 6 * DAY);

  // Review Focus 4: private windows get neither snooze nor sweep.
  await page.evaluate(() => { window.testState.isPrivate = true; window.fireEvent("tabs-changed", structuredClone(window.testState)); });
  await eventually(async () => (await page.locator("button.tab-snooze").count()) === 0, "no moon in private");
  assert.equal(await pill.count(), 0);

  assert.deepEqual(errors, []);
  console.log("snooze-browser: ok" + (capture ? ` — screenshots in ${shots}` : ""));
} finally {
  await browser.close();
}
```

- [ ] **Step 2: Run it**

Start `npm run dev` in the background, then run:
`TWIG_PLAYWRIGHT_MODULE=/Users/yash/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs CAPTURE=1 node tests/snooze-browser.mjs`
Expected: `snooze-browser: ok — screenshots in …`. Fix product code on failure. Change an assertion only when it contradicts the spec, and record a ruling when you do.

- [ ] **Step 3: Prove the test can fail.** Temporarily change `if (count >= MAX_FAILURES)` to `if (false)` in `snooze-actions.ts`. Re-run and expect `timed out waiting for broken tab archived`. Restore it.

- [ ] **Step 4: Look at the 4 screenshots.** Check four things:
  - the picker sits below the chrome with 6 aligned rows;
  - the shelf shows "Wakes …";
  - the pill sits left of + without wrapping;
  - the panel is flush right with checkboxes and three buttons.

- [ ] **Step 5: Write the docs**

`docs/snooze.md`:

```markdown
# Snooze and sweep

## Snooze

Snooze a tab from the moon button on the tab (on hover), **⌥⌘S**, or ⌘K → "Snooze tab…". Pick one of:

- In 1 hour
- This evening (6 PM, or tomorrow evening after 5 PM)
- Tomorrow morning (9 AM)
- This weekend (Saturday 9 AM)
- Next week (Monday 9 AM)
- A date and time you choose

The tab closes right away without going to Closed tabs. When its time comes, it comes back asleep at the end of its original space, with a small dot until you look at it. If that space is gone, it comes back to the space you're in. It never switches your tab or space.

The tab comes back as a fresh load of its address. Back/forward history and scroll position aren't kept.

If twig is closed at the wake time, the tab comes back the next time twig starts. twig checks at least once a minute, so after a laptop sleeps through a wake time, the tab reappears within about a minute of waking. Only the main window brings tabs back, and private windows can't snooze.

**Library → Snoozed** lists what's waiting. Click a row to bring it back now. Cancelling moves the tab to Closed tabs rather than deleting it. A tab that fails to reopen three times in a row also goes to Closed tabs.

## Sweep

twig records when each tab was last on screen, and keeps that across restarts. When three or more tabs have gone untouched past your threshold, a quiet **N untouched tabs** pill appears in the tab strip. Nothing happens until you open it.

The panel lists them oldest first, all checked, with three options:

- **Archive** closes the checked tabs into Library → Closed, where they're searchable.
- **Snooze to next week** snoozes them all.
- **Not now** hides the pill for a week.

The tab on screen, and its split partner, are never counted. Set the threshold in **Settings → Memory**: Off, 1 week, 3 weeks (the default) or 1 month. Tabs from before this feature count as used on the day you upgraded.
```

In `README.md`, under **The rest**, add as the first bullet: `- **Snooze and sweep:** snooze a tab until later (⌥⌘S), and archive tabs you haven't touched in weeks when twig suggests it ([details](docs/snooze.md))`. Add `| \`⌥⌘S\` | Snooze tab |` to the shortcuts table, after the `⇧⌘F` row.

- [ ] **Step 6: Final verification and commit**

Run: `npm test && npm run build && (cd src-tauri && cargo check && cargo test)`

```bash
git add tests/snooze-browser.mjs docs/snooze.md README.md
git commit -m "test: drive snooze and sweep end to end, and document them"
```

Push happens after the final review: `git push origin main`.
