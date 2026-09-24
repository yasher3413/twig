import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL("../src/store/changes.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function load(stored) {
  const items = new Map(stored === undefined ? [] : [["twig:changes-muted", stored]]);
  const localStorage = { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v) };
  const exports = {};
  runInNewContext(source, { exports, URL, localStorage, require(name) { assert.equal(name, "zustand"); return require("zustand"); } });
  return { store: exports.useChangeStore, items };
}
const change = (url) => ({ url, capturedAt: 2, baselineId: 1, baselineAt: 1, currentBody: "x", summary: { added: 1, removed: 0, edited: 0 } });

test("prune drops changes for tabs that closed or navigated", () => {
  const { store } = load();
  store.getState().set("1", change("https://a.example/x"));
  store.getState().set("2", change("https://b.example/y"));
  store.getState().set("3", change("https://c.example/z"));
  store.getState().prune([{ id: "1", url: "https://a.example/x" }, { id: "2", url: "https://b.example/other" }]);
  assert.deepEqual(Object.keys(store.getState().byTab), ["1"]);
});

test("clearing the open tab's change closes the panel", () => {
  const { store } = load();
  store.getState().set("1", change("https://a.example/x"));
  store.getState().open("1");
  assert.equal(store.getState().openFor, "1");
  store.getState().clear("1");
  assert.equal(store.getState().openFor, null);
  store.getState().open("1");
  assert.equal(store.getState().openFor, null, "nothing to open without a change");
});

test("muting a host persists it and drops that host's changes", () => {
  const { store, items } = load();
  store.getState().set("1", change("https://a.example/x"));
  store.getState().set("2", change("https://b.example/y"));
  store.getState().open("1");
  store.getState().mute("a.example");
  assert.deepEqual(Object.keys(store.getState().byTab), ["2"]);
  assert.equal(store.getState().openFor, null);
  assert.equal(items.get("twig:changes-muted"), '["a.example"]');
  store.getState().unmute("a.example");
  assert.equal(items.get("twig:changes-muted"), "[]");
});

test("stored mute list survives a restart and tolerates junk", () => {
  assert.deepEqual([...load('["a.example", 3]').store.getState().muted], ["a.example"]);
  assert.deepEqual([...load("{not json").store.getState().muted], []);
});
