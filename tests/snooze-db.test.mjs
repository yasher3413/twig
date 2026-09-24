import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const now = 1_800_000_000_000;
function setup() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../src-tauri/migrations/006_snoozed.sql", import.meta.url), "utf8"));
  const bind = (values = []) => Object.fromEntries(values.map((v, i) => [`$${i + 1}`, v]));
  const adapter = {
    async execute(query, values) { return sql.prepare(query).run(bind(values)); },
    async select(query, values) { return sql.prepare(query).all(bind(values)); },
  };
  const api = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/snooze-db.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports: api, Date: class extends Date { static now() { return now; } },
    require(name) { assert.equal(name, "@tauri-apps/plugin-sql"); return { __esModule: true, default: { get: () => adapter } }; },
  });
  return { api, sql };
}
const row = (url, wakeAt) => ({ url, title: url.slice(8), spaceId: "1", spaceName: "Space 1", wakeAt });

test("due rows are the ones whose time has come, soonest first", async () => {
  const { api } = setup();
  await api.addSnooze(row("https://later.example/", now + 60_000));
  await api.addSnooze(row("https://b.example/", now - 1_000));
  await api.addSnooze(row("https://a.example/", now - 5_000));
  const due = await api.dueSnoozes(now);
  assert.deepEqual(due.map((r) => r.url), ["https://a.example/", "https://b.example/"]);
  assert.equal(due[0].spaceName, "Space 1");
  assert.equal(due[0].snoozedAt, now);
  assert.equal(await api.nextWakeAt(), now - 5_000);
});

test("list, delete, and an empty table", async () => {
  const { api } = setup();
  assert.equal(await api.nextWakeAt(), null);
  await api.addSnooze(row("https://x.example/", now + 10));
  await api.addSnooze(row("https://y.example/", now + 5));
  const all = await api.listSnoozes();
  assert.deepEqual(all.map((r) => r.url), ["https://y.example/", "https://x.example/"]);
  await api.deleteSnooze(all[0].id);
  assert.deepEqual((await api.listSnoozes()).map((r) => r.url), ["https://x.example/"]);
});
