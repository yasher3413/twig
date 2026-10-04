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

function bridge(invoke, events = []) {
  const exports = {};
  runInNewContext(outputText, {
    exports,
    window: { dispatchEvent: (e) => events.push(e) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    require(name) {
      assert.equal(name, "@tauri-apps/api/core");
      // Snapshots are their own concern (tested below); these tests are
      // about the show/hide calls.
      return { invoke: (command, args) => command === "snapshot_visible_tabs" ? Promise.resolve([]) : invoke(command, args) };
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

test("a side panel handing over to another keeps the page narrowed", async () => {
  const exports = {};
  const insets = [];
  runInNewContext(outputText, {
    exports,
    require() { return { invoke: async (command, args) => { assert.equal(command, "set_content_inset"); insets.push(args.right); } }; },
  });
  // The new panel mounts before the old one's cleanup runs.
  await exports.setContentInset(380, "sweep");
  await exports.setContentInset(0, "changes");
  assert.equal(insets.at(-1), 380, "the old panel's release must not undo the new panel's claim");
  await exports.setContentInset(0, "sweep");
  assert.equal(insets.at(-1), 0);
});

test("the page is pictured before it is hidden, and the picture goes once it is back", async () => {
  const calls = [];
  const events = [];
  const exports = {};
  const shot = { x: 0, y: 84, width: 800, height: 600, image: "data:image/jpeg;base64,/9j/" };
  runInNewContext(outputText, {
    exports,
    window: { dispatchEvent: (e) => { events.push(e); calls.push(`event:${e.detail.length}`); } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    require() {
      return { invoke: async (command, args) => {
        calls.push(command === "set_overlay_active" ? `overlay:${args.open}` : command);
        return command === "snapshot_visible_tabs" ? [shot] : undefined;
      } };
    },
  });
  await exports.setOverlayActive(true, "settings");
  await exports.setOverlayActive(true, "palette");
  await exports.setOverlayActive(false, "palette");
  await exports.setOverlayActive(false, "settings");
  assert.deepEqual(calls, [
    "snapshot_visible_tabs", "event:1", "overlay:true",
    "overlay:true",
    "overlay:true",
    "overlay:false", "event:0",
  ]);
  assert.equal(events[0].type, "twig:page-snapshots");
});
