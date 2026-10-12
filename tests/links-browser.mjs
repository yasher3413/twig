// Links that open in a new window (target="_blank") did nothing in twig:
// WebKit never asked twig to open them (#4). twig's page script turns such
// clicks into window.open(), which twig does handle. Runs the real script in
// WebKit; needs no dev server.
//
//   TWIG_PLAYWRIGHT_MODULE=/path/to/playwright node tests/links-browser.mjs
const { webkit } = await import(process.env.TWIG_PLAYWRIGHT_MODULE || "playwright");
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("../src-tauri/src/tabs/new_window_links.js", import.meta.url), "utf8");
const page = `<!doctype html><body>
  <a id="blank" href="https://example.com/a" target="_blank">blank</a>
  <a id="named" href="https://example.com/b" target="report">named</a>
  <a id="noopener" href="https://example.com/c" target="_blank" rel="noopener">noopener</a>
  <a id="self" href="#here" target="_self">self</a>
  <a id="plain" href="#plain">plain</a>
  <a id="cancelled" href="https://example.com/d" target="_blank">cancelled by the site</a>
  <script>document.getElementById("cancelled").addEventListener("click", (e) => e.preventDefault());</script>
</body>`;

const browser = await webkit.launch();
try {
  const tab = await browser.newPage();
  await tab.addInitScript(() => {
    window.opened = [];
    window.open = (url, target, features) => { window.opened.push([String(url), target, features ?? ""]); return null; };
  });
  await tab.addInitScript(script);
  await tab.route("https://host.test/", (route) => route.fulfill({ contentType: "text/html", body: page }));
  await tab.goto("https://host.test/");
  for (const id of ["blank", "named", "noopener", "self", "plain", "cancelled"]) await tab.click(`#${id}`);
  const opened = await tab.evaluate(() => window.opened);
  assert.deepEqual(opened, [
    ["https://example.com/a", "_blank", ""],
    ["https://example.com/b", "report", ""],
    ["https://example.com/c", "_blank", "noopener"],
  ]);
  assert.equal(await tab.evaluate(() => location.hash), "#plain", "ordinary links still navigate the tab");
  console.log("links-browser: ok");
} finally {
  await browser.close();
}
