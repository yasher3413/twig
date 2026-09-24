import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const api = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/sweep.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: api });
const DAY = 86_400_000;
const now = 1_800_000_000_000;
const tab = (id, daysAgo) => ({ id, url: `https://${id}.example/`, title: id, status: "hibernated", groupId: "1", lastUsedAt: now - daysAgo * DAY });

test("stale tabs are the untouched ones, oldest first", () => {
  const tabs = [tab("a", 30), tab("b", 2), tab("c", 45), tab("d", 22)];
  assert.deepEqual(api.staleTabs(tabs, null, null, now, 21).map((t) => t.id), ["c", "a", "d"]);
});

test("the active tab and its split partner are never stale", () => {
  const tabs = [tab("a", 30), tab("b", 30), tab("c", 30)];
  assert.deepEqual(api.staleTabs(tabs, "a", "b", now, 21).map((t) => t.id), ["c"]);
});

test("off means nothing is ever stale", () => {
  assert.equal(api.staleTabs([tab("a", 400)], null, null, now, 0).length, 0);
});

test("suggest only with enough stale tabs and outside the cooldown", () => {
  const three = [tab("a", 30), tab("b", 30), tab("c", 30)];
  assert.equal(api.shouldSuggest(three.slice(0, 2), 0, now), false);
  assert.equal(api.shouldSuggest(three, 0, now), true);
  assert.equal(api.shouldSuggest(three, now + 1, now), false);
  assert.equal(api.shouldSuggest(three, now, now), true);
  assert.equal(api.DISMISS_FOR, 7 * DAY);
  assert.deepEqual([...api.SWEEP_CHOICES], [0, 7, 21, 30]);
  assert.deepEqual([0, 7, 21, 30].map(api.sweepChoiceLabel), ["Off", "1 week", "3 weeks", "1 month"]);
});
