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
- **Tab hibernation.** A tab you haven't looked at in 10 minutes has
  its webview torn down, keeping its title, URL and scroll position.
  Only 5 stay awake at once; the rest wake on click, where you left
  them. A tab that's *busy* — unsubmitted typing, playing media, a
  live camera or mic — is never put to sleep, even if that means
  sitting above the cap.
- **Tabs that cost nothing until used.** A new tab holds no webview at
  all, and neither does a restored one. Reopening a few hundred tabs
  costs about what reopening one does.
- **Keyboard-first.** Everything is on a real menu with a real
  accelerator, plus a `⌘K` palette that both searches and runs
  commands.

## Features

**Tabs**
- Horizontal tab strip with drag-to-reorder
- Spaces for keeping unrelated piles of tabs apart
- Split view (two pages side by side)
- Session restore — tabs and spaces survive a quit
- Closed tabs are archived and searchable, not just `⇧⌘T`-able
- Live memory readout: what's in use, what's asleep, what that saved

**Finding things**
- `⌘K` palette across open tabs, bookmarks, history, and commands
- **Full-text search of pages you've read.** Page text is indexed
  locally (SQLite FTS5), so you can find a page by a phrase inside it
  rather than by remembering its title
- Omnibox with inline autofill — type `git`, get `github.com`, Tab or
  Enter to take it
- Bookmarks and history in one library (`⇧⌘O` / `⌘Y`)
- Find-in-page

**Reading and handling pages**
- Reader view (`⌘⇧R`) — strips a page to its article
- Link hints (`⌘E`) — label every link on screen, type the label to
  follow it
- Per-site zoom, remembered across restarts
- Downloads, saved to `~/Downloads` without clobbering existing files

**The rest**
- Dark/light theme with a configurable accent
- Pick your search engine (Google, DuckDuckGo, Brave, Bing)
- Private windows — non-persistent store, nothing indexed or recorded
- Everything local. No account, no sync, nothing leaves the machine.
  History, the page index, and cookies are all clearable from Settings

Not here, by design: cross-device sync and Windows/Linux builds.

**Extensions aren't possible**, not just unimplemented — WKWebView has
no extension API, so there's no uBlock-shaped hole to fill. Content
blocking, if it happens, would go through `WKContentRuleList`, which is
a narrower thing than an extension store.

## Shortcuts

| | |
|---|---|
| `⌘T` / `⌘W` | New tab / close tab |
| `⇧⌘T` | Reopen closed tab |
| `⇧⌘W` | Close window |
| `⌘1`–`⌘9` | Jump to tab |
| `⇧⌘[` / `⇧⌘]` | Previous / next tab |
| `⌘[` / `⌘]` | Back / forward |
| `⌘L` | Focus the address bar |
| `⌘K` | Command palette |
| `⌘E` | Follow a link by keyboard |
| `⌘F` | Find in page |
| `⌘R` | Reload |
| `⌘+` / `⌘-` / `⌘0` | Zoom in / out / reset |
| `⇧⌘R` | Reader view |
| `⌘B` | Toggle the tab strip |
| `⌘D` | Bookmark this page |
| `⇧⌘O` / `⌘Y` | Bookmarks / history |
| `⇧⌘N` | New private window |
| `⌘,` | Settings |

## Stack

- [Tauri 2](https://tauri.app) (Rust) for the app shell and per-tab
  native webviews
- React + TypeScript + Vite for the browser chrome
- SQLite via `tauri-plugin-sql` for history, bookmarks, the archive,
  and the full-text index

One thing worth knowing if you're reading the source: each tab is a
separate *native* webview stacked above the chrome, so the chrome can't
draw over page content the way a normal web app would. Anything that
needs to overlap a page either slides the page down
(`set_content_offset`) or hides it (`set_overlay_active`). That
constraint shows up all over the UI code.

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

Working daily driver, rough in places. Reader view is a heuristic and
will occasionally pick the wrong block; downloads are a notification
rather than a manager. See [CONTRIBUTING.md](CONTRIBUTING.md) if you'd
like to help out.

## License

MIT — see [LICENSE](LICENSE).
