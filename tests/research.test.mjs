import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/research.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const api = {};
runInNewContext(outputText, { exports: api, URL, require() { return { invoke() { throw new Error("Unexpected native request"); } }; } });
const plain = (value) => JSON.parse(JSON.stringify(value));
const pages = [
  { url: "https://example.com/first", title: "First source" },
  { url: "https://example.org/second", title: "Second source" },
  { url: "https://example.net/third", title: "Third source" },
];

test("draft excludes non-web pages and addresses containing credentials", () => {
  const draft = api.draftFromPages("Research", [...pages,
    { url: "", title: "New tab" },
    { url: "file:///Users/me/private.txt", title: "Local file" },
    { url: "javascript:alert(1)", title: "Script" },
    { url: "https://user:secret@example.com", title: "Credentials" },
    { url: "data:text/plain,secret", title: "Inline data" },
  ], 42);
  assert.deepEqual(plain(draft.pages.map((page) => page.url)), pages.map((page) => page.url));
});

test("captured selection belongs only to its source and respects the excerpt bound", () => {
  const draft = api.draftFromPages("Research", pages, 42, { url: pages[1].url, text: "x".repeat(9000) });
  assert.equal(draft.pages[0].excerpts.length, 0);
  assert.equal(draft.pages[1].excerpts[0].length, 8000);
  assert.equal(draft.pages[2].excerpts.length, 0);
});

test("export carries selected pages in edited order and omits draft properties", () => {
  const draft = api.draftFromPages("Research", pages, 42);
  draft.pages[1].included = false;
  draft.pages = api.moveDraftPage(draft.pages, "2", -1);
  draft.pages = api.moveDraftPage(draft.pages, "2", -1);
  draft.pages[0].note = "Read this first";
  draft.pages[0].excerpts = ["A useful passage", "   "];
  const result = plain(api.packageFromDraft(draft, false));
  assert.deepEqual(result.pages.map((page) => page.url), [pages[2].url, pages[0].url]);
  assert.equal(result.pages[0].note, "Read this first");
  assert.deepEqual(result.pages[0].excerpts, ["A useful passage"]);
  assert.equal(result.sourceCheckpoint, null);
  for (const page of result.pages) assert.deepEqual(Object.keys(page).sort(), ["capturedAt", "excerpts", "note", "title", "url"]);
});

test("checkpoint provenance is shared only when explicitly included", () => {
  const draft = api.draftFromPages("Research", pages, 42);
  draft.sourceCheckpoint = { name: "Internal project title", createdAt: 21 };
  assert.equal(api.packageFromDraft(draft, false).sourceCheckpoint, null);
  assert.deepEqual(plain(api.packageFromDraft(draft, true).sourceCheckpoint), draft.sourceCheckpoint);
  assert.notEqual(api.packageFromDraft(draft, true).sourceCheckpoint, draft.sourceCheckpoint);
});

test("editing a loaded package does not mutate its stored annotations", () => {
  const value = plain(api.packageFromDraft(api.draftFromPages("Research", pages, 42), false));
  value.pages[0].excerpts = ["Original quote"];
  const draft = api.draftFromPackage(value);
  draft.pages[0].excerpts[0] = "Changed quote";
  draft.pages[0].note = "Changed note";
  assert.equal(value.pages[0].excerpts[0], "Original quote");
  assert.equal(value.pages[0].note, "");
  assert.equal(draft.pages.every((page) => page.included), true);
});

test("reorder boundaries are safe and moving a page preserves the source array", () => {
  const draft = api.draftFromPages("Research", pages, 42);
  assert.equal(api.moveDraftPage(draft.pages, "0", -1), draft.pages);
  assert.equal(api.moveDraftPage(draft.pages, "2", 1), draft.pages);
  assert.equal(api.moveDraftPage(draft.pages, "unknown", 1), draft.pages);
  const moved = api.moveDraftPage(draft.pages, "1", -1);
  assert.deepEqual(plain(moved.map((page) => page.key)), ["1", "0", "2"]);
  assert.deepEqual(plain(draft.pages.map((page) => page.key)), ["0", "1", "2"]);
});
