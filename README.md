# twig

A lightweight, tab-heavy desktop browser for macOS.

Most browsers scale memory use with tab count, because every tab is a
full, live renderer sitting in the background. If you're the kind of
person who keeps 50-100+ tabs open, that adds up fast. twig is built
around the opposite assumption: tabs you aren't looking at shouldn't
cost you anything.

## How

- **Native webview, not bundled Chromium.** twig is built on
  [Tauri 2](https://tauri.app), which uses the OS's built-in webview
  instead of shipping a Chromium runtime. On macOS that's WKWebView
  (Safari's engine) — the main source of the memory win over
  Electron-based browsers.
- **Tab hibernation.** Any tab you haven't looked at in a while has its
  webview torn down and replaced with a lightweight placeholder
  (title, favicon, scroll position, form state where feasible). Click
  it and it reloads instantly. Only the active tab and a small
  LRU window of recently-viewed tabs stay "hot" (a live webview) at
  once. Hibernation is visible per-tab, not a black box.
- **Keyboard-first.** A `Cmd+K` command palette for switching tabs,
  searching open tabs, jumping to a URL, and running commands, plus
  the usual set of tab/window shortcuts.

## Features

- Vertical tab sidebar with drag-to-reorder
- Tab groups / spaces for organizing large tab counts
- `Cmd+K` command palette
- Split view (two webviews side by side)
- Minimal chrome, hideable on demand
- Dark/light theme with a configurable accent color
- Local bookmarks and history (SQLite, no cloud sync)
- Find-in-page
- Private/incognito windows (nothing persisted)

Not in v1, by design: an extensions/plugin system, a built-in ad
blocker, cross-device sync, and Windows/Linux builds. macOS first;
the rest can come later if it's worth it.

## Stack

- [Tauri 2](https://tauri.app) (Rust) for the app shell and
  per-tab native webviews
- React + TypeScript + Vite for the browser chrome
- SQLite via `tauri-plugin-sql` for local history/bookmarks

The tab/webview management layer is kept decoupled from
WKWebView specifics, so a future move to a Chromium-based renderer
(if extension support ever turns out to matter) wouldn't require
starting over.

## Development

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Node.js](https://nodejs.org) 18+
- Xcode command line tools (`xcode-select --install`)

### Setup

```sh
npm install
npm run tauri dev
```

### Build

```sh
npm run tauri build
```

## Status

Early scaffold. See [CONTRIBUTING.md](CONTRIBUTING.md) if you'd like
to help out.

## License

MIT — see [LICENSE](LICENSE).
