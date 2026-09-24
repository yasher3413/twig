import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const migration = () => readFileSync(new URL("../src-tauri/migrations/005_recall.sql", import.meta.url), "utf8");
const now = 1_800_000_000_000;
function setup(legacy = [], beforeQuery = async () => {}) {
  const sql = new DatabaseSync(":memory:");
  sql.exec("CREATE VIRTUAL TABLE page_text USING fts5(url UNINDEXED,title,body,captured_at UNINDEXED,tokenize='porter unicode61'); CREATE TABLE history (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visited_at INTEGER)");
  for (const row of legacy) sql.prepare("INSERT INTO page_text VALUES (?,?,?,?)").run(...row);
  sql.exec(migration());
  const notifications = [];
  const exports = {};
  const { outputText } = ts.transpileModule(readFileSync(new URL("../src/lib/recall-db.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const adapter = {
    async execute(query, values = []) {
      await beforeQuery(query);
      return sql.prepare(query).run(Object.fromEntries(values.map((value, i) => [`$${i + 1}`, value])));
    },
    async select(query, values = []) {
      await beforeQuery(query);
      return sql.prepare(query).all(Object.fromEntries(values.map((value, i) => [`$${i + 1}`, value])));
    },
  };
  runInNewContext(outputText, {
    exports, URL, Date: class extends Date { static now() { return now; } },
    window: { dispatchEvent(event) { notifications.push(event.type); } },
    Event: class { constructor(type) { this.type = type; } },
    require(name) { assert.equal(name, "@tauri-apps/plugin-sql"); return { __esModule: true, default: { get: () => adapter } }; },
  });
  const historyApi = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/db.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports: historyApi,
    require(name) {
      if (name === "./recall-db") return exports;
      if (name === "./tabs") return { isInternalUrl: () => false };
      assert.equal(name, "@tauri-apps/plugin-sql");
      return { __esModule: true, default: { get: () => adapter } };
    },
  });
  return { ...exports, sql, notifications, historyApi };
}
function capture(overrides = {}) {
  return { url: "https://example.com/a", title: "Database notes", body: "SQLite preserves a useful paragraph.", capturedAt: now - 60_000, spaceId: "work", spaceName: "Work", sessionId: "session-a", ...overrides };
}

test("migration preserves legacy bodies, times and search with unknown context", async () => {
  const db = setup([["https://example.com/a", "Old title", "Historical SQLite text", now - 3_600_000]]);
  const [old] = await db.searchRecall({ query: "SQLite", spaceId: "__unknown__" });
  assert.equal(old.capturedAt, now - 3_600_000);
  assert.equal(old.spaceId, null);
  assert.equal((await db.getRecallCopy(old.id)).body, "Historical SQLite text");
  await db.indexRecall(capture());
  assert.equal((await db.searchRecall({ query: "SQLite" })).length, 2);
  assert.ok((await db.recallSpaces()).some((space) => space.id === "__unknown__"));
});

test("captures retain changed versions and deduplicate without moving timestamps", async () => {
  const db = setup();
  await db.indexRecall(capture());
  await db.indexRecall(capture({ capturedAt: now }));
  assert.equal((await db.searchRecall({ query: "" })).length, 1);
  assert.equal((await db.searchRecall({ query: "" }))[0].capturedAt, now - 60_000);
  await db.indexRecall(capture({ body: "Changed SQLite paragraph", capturedAt: now }));
  await db.indexRecall(capture({ spaceId: "personal" }));
  assert.equal((await db.searchRecall({ query: "SQLite" })).length, 3);
});

test("literal FTS terms tolerate quotes, punctuation, operators and empty tokens", async () => {
  const db = setup();
  await db.indexRecall(capture({ body: 'SQLite "database": notes AND examples. Unicode café.' }));
  for (const query of ['"SQLite"', 'database:', 'SQLite AND', 'café', '(SQLite)*']) {
    assert.equal((await db.searchRecall({ query })).length, 1, query);
  }
  assert.equal((await db.searchRecall({ query: '"!!!"' })).length, 0);
  assert.match((await db.searchRecall({ query: 'SQLite' }))[0].snippet, /\[\[SQLite\]\]/);
});

test("date filters use an exclusive end and retain recorded space names", async () => {
  const db = setup();
  await db.indexRecall(capture({ capturedAt: now - 2000 }));
  await db.indexRecall(capture({ url: "https://example.com/b", capturedAt: now - 1000, spaceId: "other" }));
  assert.equal((await db.searchRecall({ query: "", from: now - 2000, to: now - 1000 })).length, 1);
  assert.equal((await db.searchRecall({ query: "", spaceId: "other" }))[0].url, "https://example.com/b");
  assert.equal((await db.searchRecall({ query: "", spaceId: "__unknown__" })).length, 0);
});

test("nearby captures are chronological and require both space and known session", async () => {
  const db = setup();
  await db.indexRecall(capture());
  const [target] = await db.searchRecall({ query: "" });
  for (const change of [
    { url: "https://example.com/b", capturedAt: now - 120_000 },
    { url: "https://example.com/c", capturedAt: now },
    { url: "https://example.com/d", capturedAt: now - 4_000_000 },
    { url: "https://example.com/e", sessionId: "other" },
    { url: "https://example.com/f", spaceId: "other" },
    { body: "Another version" },
  ]) await db.indexRecall(capture(change));
  assert.deepEqual(Array.from(await db.nearbyRecall(target.id), (r) => r.url), ["https://example.com/b", "https://example.com/c"]);
  const oldDb = setup([["https://old.com", "Old", "text", now]]);
  assert.equal((await oldDb.nearbyRecall(1)).length, 0);
});

test("delete and clear update FTS; history forgetting shares the write queue", async () => {
  const db = setup();
  await db.indexRecall(capture());
  await db.indexRecall(capture({ body: "SQLite changed" }));
  const [row] = await db.searchRecall({ query: "" });
  await db.deleteRecallCopy(row.id);
  assert.equal((await db.searchRecall({ query: "SQLite" })).length, 1);
  await db.deleteRecallUrl(row.url);
  assert.equal((await db.searchRecall({ query: "SQLite" })).length, 0);
  db.sql.prepare("INSERT INTO history (url) VALUES (?)").run("https://example.com/b");
  await db.indexRecall(capture({ url: "https://example.com/b" }));
  await db.forgetRecallHistory("https://example.com/b");
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM history").get().n, 0);
  assert.equal((await db.searchRecall({ query: "" })).length, 0);
  assert.ok(db.notifications.every((name) => name === "twig:recall-changed"));
});

test("clear serializes with captures and rejects callbacks captured before forgetting", async () => {
  const db = setup();
  await Promise.all([db.indexRecall(capture()), db.clearRecall(), db.indexRecall(capture())]);
  assert.equal((await db.searchRecall({ query: "" })).length, 0);
  await db.indexRecall(capture({ capturedAt: now + 1 }));
  assert.equal((await db.searchRecall({ query: "" })).length, 1);
  await db.forgetRecallHistory();
  await db.indexRecall(capture());
  assert.equal((await db.searchRecall({ query: "" })).length, 0);
});

test("capture validation rejects unsafe URLs and invalid timestamps; body is bounded", async () => {
  const db = setup();
  for (const url of ["file:///tmp/private", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com/\nsecret"]) {
    await assert.rejects(db.indexRecall(capture({ url })));
  }
  for (const capturedAt of [NaN, Infinity, -1, now + 90_000]) await assert.rejects(db.indexRecall(capture({ capturedAt })));
  await db.indexRecall(capture({ body: "a".repeat(50_000) }));
  const [row] = await db.searchRecall({ query: "" });
  assert.equal((await db.getRecallCopy(row.id)).body.length, 40_000);
});

test("capacity pauses new capture, allows dedup, and preserves oversized legacy collections", async () => {
  const legacy = Array.from({ length: 2001 }, (_, i) => [`https://example.com/${i}`, "Title", "Body", now]);
  const db = setup(legacy);
  await assert.rejects(db.indexRecall(capture()), /2,000|2000/);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM recall_captures").get().n, 2001);
  await db.indexRecall(capture({ url: "https://example.com/0", title: "Title", body: "Body", spaceId: null }));
  await db.deleteRecallUrl("https://example.com/0");
  await db.deleteRecallUrl("https://example.com/1");
  await db.indexRecall(capture());
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM recall_captures").get().n, 2000);
});

test("clearing during an in-flight insert waits then deletes, and failures do not poison writes", async () => {
  let release;
  let started;
  let fail = false;
  const entered = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  let inserts = 0;
  const db = setup([], async (query) => {
    if (query.startsWith("INSERT INTO recall_captures")) {
      if (++inserts === 1) { started(); await blocked; }
      if (fail) throw new Error("Disk unavailable");
    }
  });
  const saving = db.indexRecall(capture());
  await entered;
  const clearing = db.clearRecall();
  release();
  await Promise.all([saving, clearing]);
  assert.equal((await db.searchRecall({ query: "SQLite" })).length, 0);
  fail = true;
  await assert.rejects(db.indexRecall(capture({ capturedAt: now + 1 })), /Disk unavailable/);
  fail = false;
  await db.indexRecall(capture({ capturedAt: now + 1 }));
  assert.equal((await db.searchRecall({ query: "SQLite" })).length, 1);
});

test("history APIs forget copies and reject late URL callbacks while preserving other URLs", async () => {
  const db = setup();
  await db.historyApi.indexPage(capture());
  await db.historyApi.indexPage(capture({ url: "https://example.com/b" }));
  await db.historyApi.deleteHistoryUrl("https://example.com/a");
  await db.historyApi.indexPage(capture());
  assert.equal((await db.searchRecall({ query: "SQLite" })).length, 1);
  await db.historyApi.clearHistory();
  await db.historyApi.indexPage(capture({ url: "https://example.com/b" }));
  assert.equal((await db.searchRecall({ query: "SQLite" })).length, 0);
});

test("palette deduplicates matching versions by URL using the latest matching copy", async () => {
  const db = setup();
  await db.historyApi.indexPage(capture({ body: "SQLite old body", capturedAt: now - 120_000 }));
  await db.historyApi.indexPage(capture({ body: "SQLite fresh body", capturedAt: now - 60_000 }));
  await db.historyApi.indexPage(capture({ url: "https://example.com/b" }));
  const matches = await db.historyApi.searchPages("SQLite", 8);
  assert.equal(matches.length, 2);
  assert.match(matches.find((row) => row.url.endsWith("/a")).snippet, /fresh body/);
  assert.equal((await db.historyApi.searchPages("", 8)).length, 0);
  await db.historyApi.clearPageIndex();
  assert.equal((await db.historyApi.searchPages("SQLite", 8)).length, 0);
});

test("an identical copy outside the dedup interval is retained with its new reading time", async () => {
  const db = setup();
  await db.indexRecall(capture({ capturedAt: now - 16 * 60_000 }));
  await db.indexRecall(capture({ capturedAt: now }));
  assert.equal((await db.searchRecall({ query: "SQLite" })).length, 2);
});

test("copiesBefore returns earlier copies across spaces, newest first", async () => {
  const db = setup();
  await db.indexRecall(capture({ body: "First version.", capturedAt: now - 3 * 3_600_000, spaceId: "work" }));
  await db.indexRecall(capture({ body: "Second version.", capturedAt: now - 2 * 3_600_000, spaceId: "home", spaceName: "Home" }));
  await db.indexRecall(capture({ body: "Third version.", capturedAt: now - 3_600_000 }));
  await db.indexRecall(capture({ url: "https://example.com/other", body: "Other page.", capturedAt: now - 3_600_000 }));
  const copies = await db.copiesBefore("https://example.com/a", now - 3_600_000);
  assert.deepEqual(copies.map((c) => c.body), ["Second version.", "First version."]);
  assert.equal(copies[0].capturedAt, now - 2 * 3_600_000);
  assert.equal(typeof copies[0].id, "number");
  assert.equal((await db.copiesBefore("https://example.com/a", now, 1)).length, 1);
  assert.deepEqual((await db.copiesOf("https://example.com/a")).map((c) => c.capturedAt), [now - 3_600_000, now - 2 * 3_600_000, now - 3 * 3_600_000]);
});
