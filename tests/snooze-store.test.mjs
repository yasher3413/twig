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
