import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL("../src/store/settings.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function load(stored = {}) {
  const items = new Map(Object.entries(stored));
  const themes = [];
  const exports = {};
  runInNewContext(source, {
    exports, Number, String,
    localStorage: { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v) },
    document: { documentElement: { dataset: {}, style: { setProperty() {} } } },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    require(name) {
      if (name === "zustand") return require("zustand");
      if (name === "../lib/tabs") return { setHotCap() {}, setSearchEngine() {} };
      assert.equal(name, "@tauri-apps/api/window");
      return { getCurrentWindow: () => ({ setTheme: async (theme) => { themes.push(theme); } }) };
    },
  });
  return { store: exports.useSettingsStore, themes };
}

test("web pages follow twig's theme, not only its own chrome", () => {
  const { store, themes } = load({ "twig:theme-mode": "dark" });
  store.getState().init();
  assert.equal(themes.at(-1), "dark", "a stored dark theme reaches the window on launch");
  store.getState().setThemeMode("light");
  assert.equal(themes.at(-1), "light");
  store.getState().setThemeMode("system");
  assert.equal(themes.at(-1), null, "system hands the choice back to macOS");
});
