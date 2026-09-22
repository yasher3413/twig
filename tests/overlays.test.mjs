import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the actual native bridge with a controlled IPC transport.
// TypeScript is already a project dependency; no browser or test framework
// is needed to reproduce ordering and failure cases.
const source = readFileSync(new URL("../src/lib/tabs.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});

function bridge(invoke) {
  const exports = {};
  runInNewContext(outputText, {
    exports,
    require(name) {
      assert.equal(name, "@tauri-apps/api/core");
      return { invoke };
    },
  });
  return exports.setOverlayActive;
}

test("closing the palette keeps native pages hidden behind checkpoints", async () => {
  const states = [];
  const setOverlayActive = bridge(async (command, args) => {
    assert.equal(command, "set_overlay_active");
    states.push(args.open);
  });
  await setOverlayActive(true, "palette");
  await setOverlayActive(true, "checkpoints");
  await setOverlayActive(false, "palette");
  assert.equal(states.at(-1), true);
  await setOverlayActive(false, "checkpoints");
  assert.deepEqual(states, [true, true, true, false]);
});

test("unopened panels and duplicate owner updates cannot release another panel", async () => {
  const states = [];
  const setOverlayActive = bridge(async (_, args) => states.push(args.open));
  await setOverlayActive(true, "checkpoints");
  await setOverlayActive(true, "checkpoints");
  await setOverlayActive(false, "settings");
  await setOverlayActive(false, "library");
  assert.deepEqual(states, [true, true, true, true]);
  await setOverlayActive(false, "checkpoints");
  assert.equal(states.at(-1), false);
});

test("bridge updates remain ordered even when native calls are slow", async () => {
  let release;
  const entered = new Promise((resolve) => { release = resolve; });
  let notify;
  const started = new Promise((resolve) => { notify = resolve; });
  const states = [];
  const setOverlayActive = bridge(async (_, args) => {
    states.push(args.open);
    if (states.length === 1) { notify(); await entered; }
  });
  const opening = setOverlayActive(true, "checkpoints");
  const closing = setOverlayActive(false, "checkpoints");
  await started;
  assert.deepEqual(states, [true]);
  release();
  await Promise.all([opening, closing]);
  assert.deepEqual(states, [true, false]);
});

test("an IPC failure is reported and does not strand subsequent updates", async () => {
  let attempts = 0;
  const states = [];
  const setOverlayActive = bridge(async (_, args) => {
    if (++attempts === 1) throw new Error("Native view unavailable");
    states.push(args.open);
  });
  await assert.rejects(setOverlayActive(true, "checkpoints"), /Native view unavailable/);
  await setOverlayActive(false, "checkpoints");
  await setOverlayActive(true, "palette");
  assert.deepEqual(states, [false, true]);
});
