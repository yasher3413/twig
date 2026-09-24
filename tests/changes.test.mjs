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
