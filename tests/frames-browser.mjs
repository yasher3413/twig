// Dark-mode pages showed embedded sign-in prompts (Google's "Sign in with
// Google") inside a white box (#7). Runs twig's real fix script against a
// minimal reproduction in WebKit. Needs no dev server.
//
//   TWIG_PLAYWRIGHT_MODULE=/path/to/playwright node tests/frames-browser.mjs
const { webkit } = await import(process.env.TWIG_PLAYWRIGHT_MODULE || "playwright");
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fix = readFileSync(new URL("../src-tauri/src/tabs/frames.js", import.meta.url), "utf8");
const frame = "<html><body style='margin:0;background:transparent'><div style='margin:20px;height:100px;border-radius:24px;background:#222'></div></body></html>";
const host = `<html style="color-scheme:dark;background:#111"><body style="margin:0">
  <iframe style="border:0;width:300px;height:140px;margin:30px" srcdoc="${frame.replace(/"/g, "&quot;")}"></iframe></body></html>`;

const browser = await webkit.launch();
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 200 }, colorScheme: "dark" });
  await page.addInitScript(fix);
  // A real navigation, as in twig: init scripts don't survive setContent().
  await page.route("https://host.test/", (route) => route.fulfill({ contentType: "text/html", body: host }));
  await page.goto("https://host.test/");
  await page.waitForTimeout(300);
  // The frame's top-left corner, just outside the rounded card.
  const corner = await page.screenshot({ clip: { x: 33, y: 33, width: 1, height: 1 } });
  const { data } = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return { data: [...ctx.getImageData(0, 0, 1, 1).data] };
  }, corner.toString("base64"));
  assert.ok(data[0] < 60 && data[1] < 60 && data[2] < 60, `frame corner should show the dark page, got rgb(${data.slice(0, 3)})`);
  console.log("frames-browser: ok");
} finally {
  await browser.close();
}
