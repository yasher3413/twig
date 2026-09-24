import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// The shortcut helpers are pure; transpile and load them without a
// browser. `invoke` is stubbed because the module imports it at the top.
const source = readFileSync(new URL("../src/lib/onboarding.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const module = { exports: {} };
runInNewContext(outputText, {
  module,
  exports: module.exports,
  require: () => ({ invoke: () => Promise.resolve() }),
  localStorage: { getItem: () => null, setItem() {} },
  window: { dispatchEvent() {} },
  CustomEvent: class {},
});
const { canonAccel, recordKey, RESERVED, greeting } = module.exports;
// Arrays built inside the VM context carry that realm's Array prototype,
// which strict deep-equality rejects; copy them into this one.
const displayAccel = (accel) => [...module.exports.displayAccel(accel)];

function key(code, key, mods = {}) {
  return { code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

test("a default and a recording of the same keys compare equal", () => {
  // Defaults are written the way humans write them; recordings come back
  // as KeyboardEvent.code. Treating these as different would make
  // re-recording a default look like a change, and hide real conflicts.
  assert.equal(canonAccel("CmdOrCtrl+,"), canonAccel("CmdOrCtrl+Comma"));
  assert.equal(canonAccel("CmdOrCtrl+T"), canonAccel("CmdOrCtrl+KeyT"));
  assert.equal(canonAccel("CmdOrCtrl+1"), canonAccel("CmdOrCtrl+Digit1"));
  assert.equal(canonAccel("CmdOrCtrl+["), "CmdOrCtrl+BracketLeft");
});

test("modifier order doesn't matter", () => {
  assert.equal(canonAccel("Shift+CmdOrCtrl+KeyT"), canonAccel("CmdOrCtrl+Shift+T"));
  assert.equal(canonAccel("Alt+Ctrl+KeyP"), "Ctrl+Alt+KeyP");
});

test("shortcuts display in macOS order and glyphs", () => {
  assert.deepEqual(displayAccel("CmdOrCtrl+Shift+KeyT"), ["⇧", "⌘", "T"]);
  assert.deepEqual(displayAccel("CmdOrCtrl+Alt+Ctrl+KeyP"), ["⌃", "⌥", "⌘", "P"]);
  assert.deepEqual(displayAccel("CmdOrCtrl+Comma"), ["⌘", ","]);
  assert.deepEqual(displayAccel("CmdOrCtrl+BracketRight"), ["⌘", "]"]);
  assert.deepEqual(displayAccel(""), []);
});

test("recording turns a keypress into a canonical accelerator", () => {
  const got = recordKey(key("KeyJ", "j", { metaKey: true, shiftKey: true }));
  assert.deepEqual({ ...got }, { kind: "accel", accel: "CmdOrCtrl+Shift+KeyJ" });
});

test("a lone modifier keeps listening rather than committing", () => {
  assert.equal(recordKey(key("MetaLeft", "Meta", { metaKey: true })).kind, "pending");
  assert.equal(recordKey(key("ShiftLeft", "Shift", { shiftKey: true })).kind, "pending");
});

test("a bare key is refused, since it would fire while typing", () => {
  assert.equal(recordKey(key("KeyJ", "j")).kind, "invalid");
  assert.equal(recordKey(key("KeyJ", "J", { shiftKey: true })).kind, "invalid");
});

test("function keys are allowed on their own", () => {
  assert.equal(recordKey(key("F5", "F5")).kind, "accel");
});

test("escape cancels and backspace clears", () => {
  assert.equal(recordKey(key("Escape", "Escape")).kind, "cancel");
  assert.equal(recordKey(key("Backspace", "Backspace")).kind, "clear");
  // With a modifier they're ordinary shortcuts, not controls.
  assert.equal(recordKey(key("Backspace", "Backspace", { metaKey: true })).kind, "accel");
});

test("system shortcuts and tab numbers are reserved", () => {
  assert.equal(RESERVED[canonAccel("CmdOrCtrl+Q")], "Quit");
  assert.equal(RESERVED[canonAccel("CmdOrCtrl+C")], "Copy");
  assert.equal(RESERVED[canonAccel("CmdOrCtrl+Digit3")], "Go to tab 3");
  assert.equal(RESERVED[canonAccel("CmdOrCtrl+KeyJ")], undefined);
});

test("greetings follow the clock and the name is optional", () => {
  const at = (h) => new Date(2026, 0, 1, h);
  assert.equal(greeting("Yash", at(9)), "Good morning, Yash");
  assert.equal(greeting("Yash", at(14)), "Good afternoon, Yash");
  assert.equal(greeting("", at(20)), "Good evening");
  assert.equal(greeting("", at(2)), "Still up");
});
