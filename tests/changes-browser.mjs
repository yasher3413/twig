// Drives change detection in WebKit against the running Vite dev server,
// with the Tauri bridge mocked and SQLite in memory.
//
//   npm run dev
//   TWIG_PLAYWRIGHT_MODULE=/path/to/playwright CAPTURE=1 node tests/changes-browser.mjs
const { webkit } = await import(process.env.TWIG_PLAYWRIGHT_MODULE || "playwright");
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const url = process.env.TWIG_TEST_URL || "http://localhost:1420";
const shots = mkdtempSync(join(tmpdir(), "twig-changes-"));
const capture = !!process.env.CAPTURE;
const DAY = 86_400_000;
const PAGE = "https://docs.example.com/guide";

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE bookmarks(id INTEGER PRIMARY KEY, url TEXT UNIQUE, title TEXT, created_at INTEGER);
         CREATE TABLE history(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visited_at INTEGER);
         CREATE TABLE archive(id INTEGER PRIMARY KEY, url TEXT, title TEXT, closed_at INTEGER);
         CREATE VIRTUAL TABLE page_text USING fts5(url UNINDEXED, title, body, captured_at UNINDEXED, tokenize='porter unicode61');`);
db.exec(readFileSync(new URL("../src-tauri/migrations/005_recall.sql", import.meta.url), "utf8"));
const oldBody = ["Getting started with the runtime.", "Spawning tasks is cheap.", "Blocking calls stall the executor.",
  "Use channels to talk between tasks.", "See the changelog for details."].join("\n\n");
const newBody = ["Getting started with the runtime.", "Spawning tasks is cheap and fast.",
  "Use channels to talk between tasks.", "See the changelog for details.", "Runtime::block_on now panics inside async contexts."].join("\n\n");
db.prepare(`INSERT INTO recall_captures (url, title, body, captured_at, space_id, space_name, session_id) VALUES (?, ?, ?, ?, '1', 'Space 1', 's0')`)
  .run(PAGE, "Guide", oldBody, Date.now() - 12 * DAY);

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

await page.addInitScript((pageUrl) => {
  localStorage.setItem("twig:welcome-done", "1");
  const callbacks = new Map();
  const listeners = new Map();
  let next = 1;
  window.calls = [];
  window.testState = {
    tabs: [{ id: "1", url: pageUrl, title: "Guide", status: "hot", groupId: "1" }, { id: "2", url: "https://other.example.com/", title: "Other", status: "hot", groupId: "1" }],
    activeId: "1", splitId: null, groups: [{ id: "1", name: "Space 1" }], activeGroupId: "1", tabStripVisible: true, isPrivate: false,
  };
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
      if (command === "activate_tab") {
        window.testState.activeId = args.id;
        window.fireEvent("tabs-changed", structuredClone(window.testState));
        return null;
      }
      if (command === "get_keymap") return [];
      if (command === "memory_stats") return { footprintKb: 0, processCount: 0, awakeTabs: 0, sleepingTabs: 0, estimatedSavedKb: 0 };
      return null;
    },
  };
}, PAGE);

async function shot(name) {
  if (!capture) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}
// Dev runs under React.StrictMode, which mounts effects twice, so only the
// latest inset is meaningful.
const lastInset = () => page.evaluate(() => window.calls.filter((c) => c.command === "set_content_inset").at(-1)?.args.right);
async function eventually(check, what) {
  for (let i = 0; i < 40; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 50)); }
  assert.fail(`timed out waiting for ${what}`);
}
const captureNow = (body) => page.evaluate(({ pageUrl, body }) => window.fireEvent("page-captured", {
  tabId: "1", url: pageUrl, title: "Guide", body, capturedAt: Date.now(), spaceId: "1", spaceName: "Space 1", sessionId: "s1",
}), { pageUrl: PAGE, body });
const chip = page.locator("button.change-chip");
const panel = page.getByRole("complementary", { name: "Changes to this page" });

try {
  await page.goto(url);
  await page.locator(".address-bar").waitFor();

  // Revisit with changed text: chip appears, and the capture is still indexed.
  await captureNow(newBody);
  await chip.waitFor();
  assert.match(await chip.textContent(), /^Changed · /);
  await eventually(() => db.prepare("SELECT COUNT(*) n FROM recall_captures").get().n === 2, "the capture to be indexed");
  await shot("1-chip");

  // Panel opens beside the page and shows the real differences.
  await chip.click();
  await panel.waitFor();
  assert.equal(await lastInset(), 380);
  assert.equal(await panel.locator(".change-passage.added").first().textContent(), "Added: Runtime::block_on now panics inside async contexts.");
  assert.equal(await panel.locator(".change-passage.removed").count(), 1);
  assert.ok(await panel.locator(".change-passage.edited ins").count() >= 1);
  await shot("2-panel");

  // Esc closes and gives the page its width back.
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  assert.equal(await lastInset(), 0);

  // A reload seconds later keeps the chip (Review Focus 1).
  await captureNow(newBody);
  await page.waitForTimeout(200);
  assert.equal(await chip.count(), 1, "reload must not clear the chip");

  // Switching tabs closes the panel and restores width (Review Focus 4).
  await chip.click();
  await panel.waitFor();
  await page.evaluate(() => { window.testState.activeId = "2"; window.fireEvent("tabs-changed", structuredClone(window.testState)); });
  await panel.waitFor({ state: "detached" });
  assert.equal(await lastInset(), 0);
  await page.evaluate(() => { window.testState.activeId = "1"; window.fireEvent("tabs-changed", structuredClone(window.testState)); });
  await chip.waitFor();

  // Forgetting the page in Recall clears the chip (Review Focus 5).
  db.exec(`DELETE FROM recall_captures WHERE url = '${PAGE}'`);
  await page.evaluate(() => window.dispatchEvent(new Event("twig:recall-changed")));
  await chip.waitFor({ state: "detached" });

  // Re-seed so the page is flagged again.
  db.prepare(`INSERT INTO recall_captures (url, title, body, captured_at, space_id, space_name, session_id) VALUES (?, 'Guide', ?, ?, '1', 'Space 1', 's0')`)
    .run(PAGE, oldBody, Date.now() - 12 * DAY);
  await captureNow(newBody);
  await chip.waitFor();

  // Navigating the tab elsewhere drops the chip.
  await page.evaluate(() => { window.testState.tabs[0].url = "https://docs.example.com/other"; window.fireEvent("tabs-changed", structuredClone(window.testState)); });
  await chip.waitFor({ state: "detached" });
  await page.evaluate((pageUrl) => { window.testState.tabs[0].url = pageUrl; window.fireEvent("tabs-changed", structuredClone(window.testState)); }, PAGE);
  db.exec(`DELETE FROM recall_captures WHERE url = '${PAGE}'`);
  db.prepare(`INSERT INTO recall_captures (url, title, body, captured_at, space_id, space_name, session_id) VALUES (?, 'Guide', ?, ?, '1', 'Space 1', 's0')`)
    .run(PAGE, oldBody, Date.now() - 12 * DAY);
  await captureNow(newBody);
  await chip.waitFor();

  // Mute from the panel.
  await chip.click();
  await page.getByRole("button", { name: "Don't flag changes on docs.example.com" }).click();
  await chip.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("twig:changes-muted"))), ["docs.example.com"]);

  assert.deepEqual(errors, []);
  console.log("changes-browser: ok" + (capture ? ` — screenshots in ${shots}` : ""));
} finally {
  await browser.close();
}
