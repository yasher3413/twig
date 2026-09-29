import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const api = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../relay/lib/report.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: api, Map, Date });
const plain = (v) => JSON.parse(JSON.stringify(v));
const good = { happened: "Tabs vanished after restart", expected: "They stay", contact: "@yash", diagnostics: { version: "0.1.1", macos: "26.2", chip: "arm64" }, website: "" };

test("a real report becomes a labelled issue", () => {
  const result = plain(api.parseReport(good));
  assert.equal(result.ok, true);
  const issue = plain(api.issueFor(result.report));
  assert.equal(issue.title, "Tabs vanished after restart");
  assert.deepEqual(issue.labels, ["bug", "from-twig"]);
  assert.match(issue.body, /### What happened\n\nTabs vanished after restart/);
  assert.match(issue.body, /### What I expected\n\nThey stay/);
  assert.match(issue.body, /twig 0\.1\.1 · macOS 26\.2 · arm64/);
  assert.match(issue.body, /Contact: @yash/);
});

test("long first lines make a short title", () => {
  const issue = api.issueFor(api.parseReport({ ...good, happened: "x".repeat(200) + "\nmore" }).report);
  assert.ok(issue.title.length <= 80 && issue.title.endsWith("…"));
});

test("empty, oversized, malformed and bot reports are refused", () => {
  assert.equal(api.parseReport({ ...good, happened: "   " }).ok, false);
  assert.equal(api.parseReport({ ...good, happened: "x".repeat(5001) }).ok, false);
  assert.equal(api.parseReport({ ...good, website: "http://spam" }).ok, false, "honeypot filled");
  assert.equal(api.parseReport(null).ok, false);
  assert.equal(api.parseReport({ happened: 42 }).ok, false);
});

test("optional parts can be left out, and nothing unexpected is echoed", () => {
  const r = api.parseReport({ happened: "Crash", website: "" });
  assert.equal(r.ok, true);
  const body = api.issueFor(r.report).body;
  assert.doesNotMatch(body, /What I expected|Contact|twig \d/);
});

test("each sender gets five reports an hour", () => {
  const limit = api.createLimiter(5, 3_600_000);
  for (let i = 0; i < 5; i++) assert.equal(limit("1.2.3.4", 0), true);
  assert.equal(limit("1.2.3.4", 1000), false);
  assert.equal(limit("5.6.7.8", 1000), true, "other senders unaffected");
  assert.equal(limit("1.2.3.4", 3_600_001), true, "window rolls over");
});
