import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compile = (path, modules = {}) => {
  const api = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: api, Map, Date, URL, URLSearchParams, JSON, Error, require: (n) => modules[n] });
  return api;
};
const relay = compile("../relay/lib/report.ts");
const api = compile("../src/lib/bug-report.ts", { "../../relay/lib/report": relay });
const plain = (v) => JSON.parse(JSON.stringify(v));
const setup = { version: "0.1.1", macos: "26.2", chip: "arm64" };

test("the report carries what you wrote, and setup only if you allow it", () => {
  const withSetup = plain(api.buildReport({ happened: "  Tabs vanished ", expected: "", contact: " @yash ", includeSetup: true }, setup));
  assert.deepEqual(withSetup, { happened: "Tabs vanished", expected: null, contact: "@yash", diagnostics: setup, website: "" });
  assert.equal(api.buildReport({ happened: "x", expected: "", contact: "", includeSetup: false }, setup).diagnostics, null);
});

test("the GitHub fallback opens a prefilled issue with the same wording", () => {
  const url = new URL(api.fallbackIssueUrl(api.buildReport({ happened: "Crash on launch", expected: "", contact: "", includeSetup: true }, setup)));
  assert.equal(url.origin + url.pathname, "https://github.com/yasher3413/twig/issues/new");
  assert.equal(url.searchParams.get("title"), "Crash on launch");
  assert.match(url.searchParams.get("body"), /### What happened\n\nCrash on launch/);
  assert.equal(url.searchParams.get("labels"), "bug,from-twig");
});

test("sending: filed, refused, or unreachable", async () => {
  const report = api.buildReport({ happened: "x", expected: "", contact: "", includeSetup: false }, setup);
  const ok = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });
  assert.deepEqual(plain(await api.sendReport(report, ok(201, { number: 12, url: "https://github.com/yasher3413/twig/issues/12" }))),
    { ok: true, number: 12, url: "https://github.com/yasher3413/twig/issues/12" });
  assert.deepEqual(plain(await api.sendReport(report, ok(429, { error: "Try again in an hour." }))), { ok: false, error: "Try again in an hour." });
  assert.equal((await api.sendReport(report, async () => { throw new TypeError("offline"); })).ok, false);
});
