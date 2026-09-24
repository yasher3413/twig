// Drives snooze and sweep in WebKit against the running Vite dev server,
// with the Tauri bridge mocked and SQLite in memory.
//
//   npm run dev
//   TWIG_PLAYWRIGHT_MODULE=/path/to/playwright CAPTURE=1 node tests/snooze-browser.mjs
const { webkit } = await import(process.env.TWIG_PLAYWRIGHT_MODULE || "playwright");
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const url = process.env.TWIG_TEST_URL || "http://localhost:1420";
const shots = mkdtempSync(join(tmpdir(), "twig-snooze-"));
const capture = !!process.env.CAPTURE;
const DAY = 86_400_000;
const now = Date.now();

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE bookmarks(id INTEGER PRIMARY KEY, url TEXT UNIQUE, title TEXT, created_at INTEGER);
         CREATE TABLE history(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visited_at INTEGER);
         CREATE TABLE archive(id INTEGER PRIMARY KEY, url TEXT, title TEXT, closed_at INTEGER);
         CREATE VIRTUAL TABLE page_text USING fts5(url UNINDEXED, title, body, captured_at UNINDEXED, tokenize='porter unicode61');`);
db.exec(readFileSync(new URL("../src-tauri/migrations/005_recall.sql", import.meta.url), "utf8"));
db.exec(readFileSync(new URL("../src-tauri/migrations/006_snoozed.sql", import.meta.url), "utf8"));
// Due while twig was closed (Review Focus 1), and one that can never reopen (Review Focus 3).
db.prepare("INSERT INTO snoozed (url, title, space_id, space_name, wake_at, snoozed_at) VALUES (?, ?, '1', 'Space 1', ?, ?)")
  .run("https://missed.example/", "Missed while closed", now - 60_000, now - DAY);
db.prepare("INSERT INTO snoozed (url, title, space_id, space_name, wake_at, snoozed_at) VALUES (?, ?, '1', 'Space 1', ?, ?)")
  .run("https://broken.example/", "Broken", now - 60_000, now - DAY);

const browser = await webkit.launch();
const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, colorScheme: "light", deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.exposeFunction("testSql", (command, query, values) => {
  const statement = db.prepare(query);
  const bindings = Object.fromEntries((values ?? []).map((v, i) => ["$" + (i + 1), v]));
  if (command === "plugin:sql|select") return statement.all(bindings);
  const r = statement.run(bindings);
  return [Number(r.changes), Number(r.lastInsertRowid)];
});

await page.addInitScript(({ now, DAY }) => {
  localStorage.setItem("twig:welcome-done", "1");
  localStorage.setItem("twig:sweep-days", "7");
  const callbacks = new Map();
  const listeners = new Map();
  let next = 1;
  let nextTab = 100;
  window.calls = [];
  const t = (id, url, daysAgo) => ({ id, url, title: url.replace("https://", "").replace(/\/$/, ""), status: "hibernated", groupId: "1", lastUsedAt: now - daysAgo * DAY });
  window.testState = {
    tabs: [
      { ...t("1", "https://docs.example/", 0), status: "hot" },
      t("2", "https://read-later.example/", 1),
      t("3", "https://old-a.example/", 10), t("4", "https://old-b.example/", 12),
      t("5", "https://old-c.example/", 15), t("6", "https://old-d.example/", 30),
    ],
    activeId: "1", splitId: null, groups: [{ id: "1", name: "Space 1" }], activeGroupId: "1", tabStripVisible: true, isPrivate: false,
  };
  const emit = () => window.fireEvent("tabs-changed", structuredClone(window.testState));
  window.fireEvent = (event, payload) => { for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ payload }); };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback(cb) { const id = next++; callbacks.set(id, cb); return id; },
    async invoke(command, args = {}) {
      window.calls.push({ command, args });
      if (command === "plugin:event|listen") {
        listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]);
        return args.handler;
      }
      if (command.startsWith("plugin:sql|")) return window.testSql(command, args.query, args.values);
      if (command === "list_tabs") return structuredClone(window.testState);
      if (command === "close_tab") {
        window.testState.tabs = window.testState.tabs.filter((x) => x.id !== args.id);
        emit();
        return null;
      }
      if (command === "activate_tab") {
        window.testState.activeId = args.id;
        const tab = window.testState.tabs.find((x) => x.id === args.id);
        if (tab) { tab.status = "hot"; tab.lastUsedAt = Date.now(); }
        emit();
        return null;
      }
      if (command === "open_background_tab") {
        if (args.url.includes("broken")) throw new Error("webview refused");
        const tab = { id: String(nextTab++), url: args.url, title: args.title, status: "hibernated", groupId: args.groupId ?? "1", lastUsedAt: Date.now() };
        window.testState.tabs.push(tab);
        emit();
        return tab;
      }
      if (command === "get_keymap") return [];
      if (command === "memory_stats") return { footprintKb: 0, processCount: 0, awakeTabs: 0, sleepingTabs: 0, estimatedSavedKb: 0 };
      return null;
    },
  };
}, { now, DAY });

async function shot(name) {
  if (!capture) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}
async function eventually(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail(`timed out waiting for ${what}`);
}
const calls = (name) => page.evaluate((n) => window.calls.filter((c) => c.command === n).map((c) => c.args), name);
const count = (sql, ...v) => db.prepare(sql).get(...v).n;

try {
  await page.goto(url);
  await page.locator(".tab-strip").waitFor();

  // Review Focus 1: a wake that passed while closed fires on launch.
  await eventually(async () => (await calls("open_background_tab")).some((a) => a.url === "https://missed.example/"), "missed wake on launch", 3000);
  const missed = page.locator(".tab", { hasText: "Missed while closed" });
  await missed.waitFor();
  assert.equal(await missed.locator(".tab-woke").count(), 1);

  // Review Focus 3: a tab that can't reopen ends up in Closed tabs after 3 tries.
  await eventually(() => count("SELECT COUNT(*) n FROM archive WHERE url = 'https://broken.example/'") === 1, "broken tab archived");
  assert.equal(count("SELECT COUNT(*) n FROM snoozed WHERE url = 'https://broken.example/'"), 0);
  assert.equal((await calls("open_background_tab")).filter((a) => a.url.includes("broken")).length, 3);

  // Looking at a woken tab clears its dot.
  // Click the title: on a narrow tab the centre can land on a hover button.
  await missed.locator(".tab-title").click();
  await eventually(async () => (await missed.locator(".tab-woke").count()) === 0, "woke dot cleared");

  // Snooze tab 2 from its moon button.
  const tab2 = page.locator(".tab", { hasText: "read-later.example" });
  await tab2.hover();
  await tab2.getByRole("button", { name: "Snooze tab" }).click();
  const picker = page.getByRole("dialog", { name: "Snooze until…" });
  await picker.waitFor();
  assert.equal(await picker.getByRole("option").count(), 6);
  await shot("1-picker");
  await page.keyboard.press("1");
  await picker.waitFor({ state: "detached" });
  await eventually(() => count("SELECT COUNT(*) n FROM snoozed WHERE url = 'https://read-later.example/'") === 1, "snooze row");
  const wakeAt = db.prepare("SELECT wake_at w FROM snoozed WHERE url = 'https://read-later.example/'").get().w;
  assert.ok(Math.abs(wakeAt - (Date.now() + 3_600_000)) < 60_000, "in 1 hour");
  assert.deepEqual((await calls("close_tab")).map((a) => a.id), ["2"]);
  assert.equal(count("SELECT COUNT(*) n FROM archive WHERE url = 'https://read-later.example/'"), 0, "snooze is not a close-to-archive");

  // It shows on the Snoozed shelf.
  await page.evaluate(() => window.fireEvent("menu-action", "show-bookmarks"));
  await page.getByRole("button", { name: "Snoozed" }).click();
  await page.getByText(/^Wakes /).first().waitFor();
  await shot("2-snoozed-shelf");
  await page.keyboard.press("Escape");

  // Time passes: move the wake into the past and nudge the clock.
  db.prepare("UPDATE snoozed SET wake_at = ? WHERE url = 'https://read-later.example/'").run(Date.now() - 1000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.locator(".tab", { hasText: "read-later.example" }).locator(".tab-woke").waitFor();
  assert.equal(await page.evaluate(() => window.testState.activeId), (await page.evaluate(() => window.testState.tabs.find((t) => t.title === "Missed while closed").id)), "waking must not steal focus");
  assert.equal(count("SELECT COUNT(*) n FROM snoozed"), 0);

  // Sweep: four tabs untouched for 7+ days.
  const pill = page.locator("button.sweep-pill");
  await pill.waitFor();
  assert.equal(await pill.textContent(), "4 untouched tabs");
  await shot("3-pill");
  await pill.click();
  const panel = page.getByRole("complementary", { name: "Untouched tabs" });
  await panel.waitFor();
  assert.equal((await calls("set_content_inset")).at(-1)?.right, 380);
  await shot("4-sweep-panel");
  await panel.getByRole("button", { name: "Archive 4 tabs" }).click();
  await panel.waitFor({ state: "detached" });
  assert.equal(count("SELECT COUNT(*) n FROM archive WHERE url LIKE 'https://old-%'"), 4);
  await pill.waitFor({ state: "detached" });

  // Not now: re-age two tabs plus one more so the pill returns, then dismiss it.
  await page.evaluate(({ DAY }) => {
    for (const tab of window.testState.tabs) if (tab.id !== window.testState.activeId) tab.lastUsedAt = Date.now() - 20 * DAY;
    window.testState.tabs.push({ id: "50", url: "https://another.example/", title: "another", status: "hibernated", groupId: "1", lastUsedAt: Date.now() - 20 * DAY });
    window.fireEvent("tabs-changed", structuredClone(window.testState));
  }, { DAY });
  await pill.waitFor();
  await pill.click();
  await panel.getByRole("button", { name: "Not now" }).click();
  await pill.waitFor({ state: "detached" });
  assert.ok(Number(await page.evaluate(() => localStorage.getItem("twig:sweep-dismissed-until"))) > Date.now() + 6 * DAY);

  // Review Focus 4: private windows get neither snooze nor sweep.
  await page.evaluate(() => { window.testState.isPrivate = true; window.fireEvent("tabs-changed", structuredClone(window.testState)); });
  await eventually(async () => (await page.locator("button.tab-snooze").count()) === 0, "no moon in private");
  assert.equal(await pill.count(), 0);

  assert.deepEqual(errors, []);
  console.log("snooze-browser: ok" + (capture ? ` — screenshots in ${shots}` : ""));
} finally {
  await browser.close();
}
