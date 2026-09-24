import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const snooze = {};
runInNewContext(compile("../src/lib/snooze.ts"), { exports: snooze, Date, Math, Number });

// A fake world: rows in `snoozed`, tabs that get opened, rows in `archive`,
// and switches to make any step fail.
function world(rows) {
  const state = { rows: rows.map((r) => ({ ...r })), opened: [], archived: [], closed: [], fail: {}, woken: [] };
  const fail = (what) => { if (state.fail[what]) { state.fail[what]--; throw new Error(`${what} failed`); } };
  const api = {};
  runInNewContext(compile("../src/lib/snooze-actions.ts"), {
    exports: api, console: { warn() {} }, Date, Map, Error, Promise,
    window: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setTimeout() {}, clearTimeout() {} },
    Event: class { constructor(type) { this.type = type; } },
    require(name) {
      switch (name) {
        case "@tauri-apps/api/window": return { getCurrentWindow: () => ({ label: "main" }) };
        case "./snooze": return snooze;
        case "./snooze-db": return {
          async addSnooze(r) { fail("add"); state.rows.push({ id: 99, ...r }); },
          async dueSnoozes(now) { return state.rows.filter((r) => r.wakeAt <= now).map((r) => ({ ...r })); },
          async nextWakeAt() { return null; },
          async deleteSnooze(id) { fail("delete"); state.rows = state.rows.filter((r) => r.id !== id); },
        };
        case "./db": return { async archiveTab(url) { fail("archive"); state.archived.push(url); } };
        case "./tabs": return {
          isInternalUrl: (u) => !u,
          async closeTab(id, remember) { state.closed.push({ id, remember }); },
          async openBackgroundTab(url) { fail("open"); const tab = { id: `t${state.opened.length}`, url }; state.opened.push(url); return tab; },
        };
        case "../store/tabs": return { useTabStore: { getState: () => ({
          isPrivate: false, groups: [{ id: "1", name: "Space 1" }],
          tabs: [{ id: "7", url: "https://a.example/", title: "A", groupId: "1" }],
          async switchTo() {},
        }) } };
        case "../store/snooze": return { useSnoozeStore: { getState: () => ({ markWoken: (id) => state.woken.push(id) }) } };
        default: throw new Error(`unexpected import ${name}`);
      }
    },
  });
  return { api, state };
}
const due = (id, url) => ({ id, url, title: url, spaceId: "1", spaceName: "Space 1", wakeAt: 1, snoozedAt: 0 });

test("a tab that can't reopen is only dropped once it's safely in Closed tabs", async () => {
  const { api, state } = world([due(1, "https://broken.example/")]);
  state.fail.open = 99;
  state.fail.archive = 1;
  for (let i = 0; i < 3; i++) await api.wakeDue(10);
  assert.equal(state.rows.length, 1, "archive failed, so the row must survive");
  assert.deepEqual(state.archived, []);
  await api.wakeDue(10);
  assert.deepEqual(state.archived, ["https://broken.example/"]);
  assert.equal(state.rows.length, 0);
});

test("a reopened tab whose row can't be deleted is not reopened again", async () => {
  const { api, state } = world([due(1, "https://a.example/")]);
  state.fail.delete = 2;
  await api.wakeDue(10);
  await api.wakeDue(10);
  await api.wakeDue(10);
  assert.deepEqual(state.opened, ["https://a.example/"], "opened exactly once");
  assert.equal(state.rows.length, 0, "the stale row is cleaned up once deleting works");
});

test("wake now doesn't let the clock wake the same row again", async () => {
  const { api, state } = world([due(1, "https://a.example/")]);
  state.fail.delete = 1;
  await api.wakeNow(state.rows[0]).catch(() => {});
  await api.wakeDue(10);
  assert.deepEqual(state.opened, ["https://a.example/"]);
});

test("snoozing closes the tab without offering it to reopen-closed-tab", async () => {
  const { api, state } = world([]);
  await api.snoozeTab("7", Date.now() + 60_000);
  assert.deepEqual(state.closed, [{ id: "7", remember: false }]);
});
