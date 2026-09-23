import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const api = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/recall.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: api, Date, require() { return { invoke() { throw new Error("Unexpected native request"); } }; } });
const plain = (value) => JSON.parse(JSON.stringify(value));

test("snippet markers become text parts without interpreting HTML", () => {
  const parts = plain(api.snippetParts('<img onerror=x> [[SQLite]] is useful.'));
  assert.deepEqual(parts, [
    { text: '<img onerror=x> ', matched: false }, { text: 'SQLite', matched: true },
    { text: ' is useful.', matched: false },
  ]);
  assert.equal(api.snippetParts('broken [[marker')[0].text, 'broken [[marker');
});

test("live passage uses a matching contiguous fragment and strips FTS markers", () => {
  assert.equal(api.passageFromSnippet('…An [[SQLite]]\n database…Other text'), 'An SQLite database');
  assert.equal(api.passageFromSnippet('x'.repeat(2500)).length, 2000);
});

test("saved reading highlighting follows literal word tokenization", () => {
  const parts = plain(api.readingParts('SQLite databases and café notes. <script>literal</script>', '"sqlite", café'));
  assert.deepEqual(parts.filter((part) => part.matched).map((part) => part.text), ['SQLite', 'café']);
  assert.equal(parts.map((part) => part.text).join(''), 'SQLite databases and café notes. <script>literal</script>');
  assert.equal(api.readingParts('ordinary text', '[]()!!!')[0].text, 'ordinary text');
});

test("inclusive local calendar dates become exclusive next-midnight bounds", () => {
  const bounds = api.localDayBounds('2026-03-08', '2026-03-08');
  const start = new Date(bounds.from); const end = new Date(bounds.to);
  assert.equal(start.getDate(), 8); assert.equal(start.getHours(), 0);
  assert.equal(end.getDate(), 9); assert.equal(end.getHours(), 0);
  assert.equal(api.dateInputValue(start), '2026-03-08');
  assert.deepEqual(plain(api.localDayBounds('', '')), {});
});

test("invalid or reversed calendar ranges are rejected", () => {
  assert.throws(() => api.localDayBounds('2026-02-30', ''), /valid/);
  assert.throws(() => api.localDayBounds('nonsense', ''), /valid/);
  assert.throws(() => api.localDayBounds('2026-09-23', '2026-09-22'), /start date/);
});
