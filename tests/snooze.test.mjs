process.env.TZ = "America/New_York";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const api = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/snooze.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: api, Date, Math, Number });
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const byId = (presets) => Object.fromEntries(presets.map((p) => [p.id, p]));

test("presets on a Tuesday morning", () => {
  const now = local(2026, 9, 22, 10, 0); // Tue
  const p = byId(api.snoozePresets(now));
  assert.deepEqual([...api.snoozePresets(now).map((x) => x.id)], ["hour", "evening", "tomorrow", "weekend", "week"]);
  assert.equal(p.hour.at, now.getTime() + 3_600_000);
  assert.equal(p.evening.at, local(2026, 9, 22, 18).getTime());
  assert.equal(p.evening.label, "This evening");
  assert.equal(p.tomorrow.at, local(2026, 9, 23, 9).getTime());
  assert.equal(p.weekend.at, local(2026, 9, 26, 9).getTime());
  assert.equal(p.weekend.label, "This weekend");
  assert.equal(p.week.at, local(2026, 9, 28, 9).getTime());
  assert.match(p.evening.detail, /^today 6:00\sPM$/u);
});

test("late in the day, evening means tomorrow evening", () => {
  const p = byId(api.snoozePresets(local(2026, 9, 22, 17, 30)));
  assert.equal(p.evening.at, local(2026, 9, 23, 18).getTime());
  assert.equal(p.evening.label, "Tomorrow evening");
});

test("on a weekend, the weekend preset is next weekend", () => {
  const sat = byId(api.snoozePresets(local(2026, 9, 26, 8, 0)));
  assert.equal(sat.weekend.at, local(2026, 10, 3, 9).getTime());
  assert.equal(sat.weekend.label, "Next weekend");
  assert.equal(sat.week.at, local(2026, 9, 28, 9).getTime());
  const sun = byId(api.snoozePresets(local(2026, 9, 27, 12, 0)));
  assert.equal(sun.weekend.at, local(2026, 10, 3, 9).getTime());
  assert.equal(sun.week.at, local(2026, 9, 28, 9).getTime());
});

test("month ends and daylight saving roll over in local time", () => {
  const jan31 = byId(api.snoozePresets(local(2026, 1, 31, 10)));
  assert.equal(jan31.tomorrow.at, local(2026, 2, 1, 9).getTime());
  // US DST starts Sun 8 Mar 2026: that day is 23 hours long.
  const tomorrow = new Date(byId(api.snoozePresets(local(2026, 3, 7, 10))).tomorrow.at);
  assert.equal(tomorrow.getDate(), 8);
  assert.equal(tomorrow.getHours(), 9);
});

test("custom times must be at least a minute ahead", () => {
  const now = local(2026, 9, 22, 10, 0).getTime();
  assert.equal(api.customWakeAt("2026-09-22T09:00", now), null);
  assert.equal(api.customWakeAt("2026-09-22T10:00", now), null);
  assert.equal(api.customWakeAt("not a date", now), null);
  assert.equal(api.customWakeAt("2026-09-22T10:05", now), local(2026, 9, 22, 10, 5).getTime());
  assert.equal(api.dateTimeValue(local(2026, 3, 4, 7, 5)), "2026-03-04T07:05");
});

test("the clock never sleeps longer than a minute", () => {
  assert.equal(api.nextDelay(null, 1000), 60_000);
  assert.equal(api.nextDelay(500, 1000), 0);
  assert.equal(api.nextDelay(31_000, 1000), 30_000);
  assert.equal(api.nextDelay(10_000_000, 1000), 60_000);
});

test("wake labels read naturally", () => {
  const now = local(2026, 9, 22, 10, 0).getTime();
  assert.match(api.wakeLabel(local(2026, 9, 23, 9).getTime(), now), /^tomorrow 9:00\sAM$/u);
  assert.match(api.wakeLabel(local(2026, 9, 26, 9).getTime(), now), /^Sat 9:00\sAM$/u);
  assert.match(api.wakeLabel(local(2026, 10, 3, 9).getTime(), now), /^Oct 3, 9:00\sAM$/u);
});
