import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const load = (path, modules = {}) => {
  const api = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: api, URL, require: (name) => modules[name] });
  return api;
};
const tabsModule = load("../src/lib/tabs.ts", { "@tauri-apps/api/core": { invoke() { throw new Error("no native calls here"); } } });
const omnibox = load("../src/lib/omnibox.ts");
const visits = load("../src/lib/visits.ts", { "./tabs": tabsModule });
const plain = (v) => JSON.parse(JSON.stringify(v));

test("autofill completes to a site, never into a search result", () => {
  const pool = ["https://www.google.com/search?q=leafs+score&sca_esv=1", "https://github.com/yasher3413/twig"];
  assert.equal(omnibox.inlineCompletion("g", pool), "google.com");
  assert.equal(omnibox.inlineCompletion("git", pool), "github.com");
  assert.equal(omnibox.inlineCompletion("GitH", pool), "github.com");
});

test("autofill goes into a path only once you've typed past the site", () => {
  const pool = ["https://github.com/yasher3413/twig", "https://www.google.com/search?q=x"];
  assert.equal(omnibox.inlineCompletion("github.com/y", pool), "github.com/yasher3413/twig");
  assert.equal(omnibox.inlineCompletion("google.com/se", pool), "google.com/search", "stops before the query");
});

test("no autofill for searches or when nothing matches", () => {
  const pool = ["https://github.com/"];
  assert.equal(omnibox.inlineCompletion("git hub", pool), null);
  assert.equal(omnibox.inlineCompletion("gitlab", pool), null);
  assert.equal(omnibox.inlineCompletion("github.com", pool), null, "already complete");
});

const tab = (id, url, title) => ({ id, url, title, status: "hot", groupId: "1", lastUsedAt: 0 });

test("every real page change is a visit, including link clicks", () => {
  const before = [tab("1", "https://a.example/", "A"), tab("2", "", "New Tab")];
  const after = [tab("1", "https://a.example/next", "a.example"), tab("2", "https://b.example/", "b.example"), tab("3", "https://c.example/", "C")];
  assert.deepEqual(plain(visits.visitChanges(before, after)), {
    visits: [
      { url: "https://a.example/next", title: "a.example" },
      { url: "https://b.example/", title: "b.example" },
      { url: "https://c.example/", title: "C" },
    ],
    retitles: [],
  });
});

test("a page naming itself later retitles its visit; waking, sleeping arrivals and internal pages don't count", () => {
  const before = [tab("1", "https://a.example/", "a.example"), tab("2", "https://b.example/", "B")];
  const after = [tab("1", "https://a.example/", "Leafs – Google Search"), { ...tab("2", "https://b.example/", "B"), status: "hibernated" }, tab("3", "data:text/html,x", "x"),
    { ...tab("4", "https://snoozed.example/", "Back from snooze"), status: "hibernated" }];
  assert.deepEqual(plain(visits.visitChanges(before, after)), {
    visits: [],
    retitles: [{ url: "https://a.example/", title: "Leafs – Google Search" }],
  });
});
