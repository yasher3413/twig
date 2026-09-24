// Drives the real welcome flow in WebKit - the engine twig renders with -
// against the running Vite dev server, with the Tauri bridge mocked.
//
//   npm run tauri dev   (or: npm run dev)
//   TWIG_PLAYWRIGHT_MODULE=/path/to/playwright CAPTURE=1 node tests/welcome-browser.mjs
//
// Without CAPTURE it only asserts. With it, screenshots of every step land
// in a temp directory that's printed at the end.
const { webkit } = await import(process.env.TWIG_PLAYWRIGHT_MODULE || "playwright");
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const url = process.env.TWIG_TEST_URL || "http://localhost:1420";
const shots = mkdtempSync(join(tmpdir(), "twig-welcome-"));
const capture = !!process.env.CAPTURE;

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE bookmarks(id INTEGER PRIMARY KEY, url TEXT UNIQUE, title TEXT, created_at INTEGER);
         CREATE TABLE history(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visited_at INTEGER);
         CREATE TABLE archive(id INTEGER PRIMARY KEY, url TEXT, title TEXT, closed_at INTEGER);
         CREATE VIRTUAL TABLE page_text USING fts5(url UNINDEXED, title, body, captured_at UNINDEXED);`);

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

await page.addInitScript(() => {
  const callbacks = new Map();
  const listeners = new Map();
  let next = 1;
  window.calls = [];
  const keymap = [
    ["new-tab", "New Tab", "File", "CmdOrCtrl+T"],
    ["close-tab", "Close Tab", "File", "CmdOrCtrl+W"],
    ["reopen-closed-tab", "Reopen Closed Tab", "File", "CmdOrCtrl+Shift+T"],
    ["focus-address", "Open Location", "Edit", "CmdOrCtrl+L"],
    ["command-palette", "Command Palette", "Edit", "CmdOrCtrl+K"],
    ["find-in-page", "Find in Page", "Edit", "CmdOrCtrl+F"],
    ["reload", "Reload Page", "View", "CmdOrCtrl+R"],
    ["toggle-reader", "Reader View", "View", "CmdOrCtrl+Shift+R"],
    ["show-history", "Show History", "History", "CmdOrCtrl+Y"],
    ["show-bookmarks", "Show Bookmarks", "History", "CmdOrCtrl+Shift+O"],
    ["next-tab", "Next Tab", "Tab", "CmdOrCtrl+Shift+BracketRight"],
    ["settings", "Settings", "twig", "CmdOrCtrl+,"],
  ].map(([id, label, group, d]) => ({ id, label, group, default: d, current: d }));

  window.fireMenu = (id) => {
    for (const handler of listeners.get("menu-action") ?? []) callbacks.get(handler)?.({ payload: id });
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback(cb) {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    async invoke(command, args = {}) {
      window.calls.push({ command, args });
      if (command === "plugin:event|listen") {
        listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]);
        return args.handler;
      }
      if (command.startsWith("plugin:sql|")) return window.testSql(command, args.query, args.values);
      if (command === "list_tabs") {
        return { tabs: [{ id: "1", url: "", title: "New Tab", status: "hot", groupId: "1" }], activeId: "1",
          splitId: null, groups: [{ id: "1", name: "Space 1" }], activeGroupId: "1", tabStripVisible: true, isPrivate: false };
      }
      if (command === "detect_browsers") return [{ id: "chrome", name: "Chrome", count: 3 }, { id: "arc", name: "Arc", count: 2 }];
      if (command === "read_browser_bookmarks") {
        return args.id === "chrome"
          ? [{ url: "https://github.com/", title: "GitHub" }, { url: "https://news.ycombinator.com/", title: "Hacker News" }, { url: "https://tauri.app/", title: "Tauri" }]
          : [{ url: "https://arc.net/", title: "Arc" }, { url: "https://github.com/", title: "GitHub" }];
      }
      if (command === "get_keymap") return structuredClone(keymap);
      if (command === "set_keymap") {
        for (const b of keymap) b.current = args.overrides[b.id] ?? b.default;
        return null;
      }
      if (command === "set_hot_cap") return args.cap;
      if (command === "memory_stats") return { footprintKb: 0, processCount: 0, awakeTabs: 0, sleepingTabs: 0, estimatedSavedKb: 0 };
      return null;
    },
  };
});

async function shot(name) {
  if (!capture) return;
  // Let the step's entrance settle so the capture shows the resting state.
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}
const next = () => page.getByRole("button", { name: /^(Continue|Get started)$/ }).click();

try {
  await page.goto(url);
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.match(await page.locator("#welcome-heading").textContent(), /keep your tabs/);
  await page.waitForTimeout(450);
  await shot("1-welcome");

  // You: name, then import from the pre-selected browser.
  await next();
  await page.getByPlaceholder("Your name").fill("Yash");
  await page.getByPlaceholder("Your name").press("Enter");
  const chrome = dialog.getByRole("button", { name: /^Chrome/ });
  assert.equal(await chrome.getAttribute("aria-pressed"), "true", "largest browser should be pre-selected");
  await dialog.getByRole("button", { name: /^Arc/ }).click();
  await page.getByRole("button", { name: /Import 5 bookmarks/ }).click();
  // github.com is in both sources: it must count once.
  await page.getByText("Added 4 bookmarks").waitFor();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bookmarks").get().n, 4);
  await shot("2-you");

  // Look: the choice has to reach the document, not just the button.
  await next();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await page.getByRole("button", { name: "Ocean" }).click();
  await page.waitForTimeout(250);
  await shot("3-look-dark");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "Moss" }).click();

  // Tour: memory style is a real setting.
  await next();
  await page.getByRole("button", { name: /Frugal/ }).click();
  assert.ok(await page.evaluate(() => window.calls.some((c) => c.command === "set_hot_cap" && c.args.cap === 3)));
  await page.waitForTimeout(600);
  await shot("4a-tour-sleep");

  await next();
  await page.evaluate(() => window.fireMenu("command-palette"));
  await page.getByText("That's the palette").waitFor();
  await page.waitForTimeout(200);
  await shot("4b-tour-palette");
  await page.keyboard.press("Escape"); // close the real palette it opened
  await next();
  await shot("4c-tour-recall");
  await next();
  await shot("4d-tour-spaces");

  // Shortcuts: record a new one and check the menu was suspended around it.
  await next();
  await page.getByRole("button", { name: /^Reload Page:/ }).click();
  await page.keyboard.press("Meta+Shift+J");
  await page.getByText("Press keys…").waitFor({ state: "detached" });
  const calls = await page.evaluate(() => window.calls.map((c) => c.command + ":" + JSON.stringify(c.args)));
  const suspends = calls.filter((c) => c.startsWith("suspend_shortcuts"));
  assert.deepEqual(suspends, ['suspend_shortcuts:{"suspended":true}', 'suspend_shortcuts:{"suspended":false}']);
  assert.ok(calls.some((c) => c.startsWith("set_keymap") && c.includes("CmdOrCtrl+Shift+KeyJ")));

  // A conflict is caught and offered, not silently applied.
  await page.getByRole("button", { name: /^Find in Page:/ }).click();
  await page.keyboard.press("Meta+t");
  await page.getByText("already opens New Tab").waitFor();
  await shot("5-keys");

  await next();
  await page.getByText("You're set, Yash.").waitFor();
  await shot("6-ready");

  // Narrow window: the illustration steps aside.
  await page.setViewportSize({ width: 760, height: 700 });
  await shot("6-ready-narrow");
  assert.equal(await page.locator(".welcome").evaluate((el) => el.scrollWidth > el.clientWidth), false);

  await page.getByRole("button", { name: "Start browsing" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => localStorage.getItem("twig:welcome-done")), "1");

  assert.deepEqual(errors, []);
  console.log("welcome flow: ok");
  if (capture) console.log("screenshots:", shots);
} finally {
  await browser.close();
}
