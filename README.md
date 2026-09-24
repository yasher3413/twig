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

**Checkpoints**
- Save a named checkpoint of the current space (`⇧⌘S`), with an optional note
- Browse a searchable timeline (`⇧⌘H`), previewing the saved tab order and split view
- Resume a checkpoint in a separate space, or give a fork a new name to explore another direction
- Reading positions are captured where possible; only the active tab and its split partner wake on restore
- Checkpoints stay unchanged as you browse, and later saves remember their parent checkpoint
- Saved locally, excluded from private windows, and individually deletable without closing open tabs

Checkpoints preserve addresses and browsing layout, not old versions of
websites, form contents, or sign-in state. Reading position restoration is
best-effort on pages that load or rearrange content dynamically. Resuming
always creates a new space, keeping your current work available.

**Research packages**

- Package the current space (`⌥⌘P`) or choose “Package this research” on a checkpoint
- Select and reorder sources, add page notes and excerpts, and preview exactly what will be shared
- A passage selected on the active web page is included when packaging that space; selections inside editable controls are excluded
- Save packages in a local library, including their notes and excerpts
- Export a portable `.twig` file, Markdown, or a standalone HTML document to Downloads without overwriting existing files
- Import a `.twig` file from Research Packages (`⇧⌘P`), preview it, then open its pages in a separate space

Packages contain only selected HTTP(S) links, titles, dates, notes, excerpts,
and optional checkpoint name/date. Full addresses (including query parameters)
are included, so review them before sharing. Cookies, form contents, local-file
tabs, and private windows are excluded. Imported files cannot run scripts;
only explicitly opening a package loads its first page. The remaining tabs
stay asleep until used. Exported HTML and Markdown can be read without Twig.

The [versioned package format](docs/research-packages.md) is documented for
other tools. There is no upload or sharing service: you choose how to send
the exported file.

**Finding things**
- `⌘K` palette across open tabs, bookmarks, history, and commands
- **Full-text search of pages you've read.** Page text is indexed
  locally (SQLite FTS5), so you can find a page by a phrase inside it
  rather than by remembering its title
- Omnibox with inline autofill — type `git`, get `github.com`, Tab or
  Enter to take it
- Bookmarks and history in one library (`⇧⌘O` / `⌘Y`)
- Find-in-page

**Recall**

- `⇧⌘F` searches dated reading copies by remembered words, space, and calendar dates
- Results show the matching passage, capture time, and the space it came from
- Read the saved plain text locally, even when the original page changes or disappears
- See pages captured in the same space and browsing session within 30 minutes
- Open a fresh live tab with a best-effort jump to the matching passage
- Delete a single copy, forget every copy of an address, or clear copies with history in Settings
- **Changes since you last read:** revisit a page and a *Changed* chip shows what's different in its text since your last visit, in a panel beside the page

Recall keeps up to 2,000 copies of 40,000 characters each. When full, new
captures pause and existing copies stay available. Identical captures in
the same space within 15 minutes are deduplicated. Forms, editable content,
hidden text, and private windows are excluded from new captures. Existing
indexed text migrates with its original capture time; its space and session
remain unknown. See [Recall's behavior and limits](docs/recall.md).

**Reading and handling pages**
- Reader view (`⌘⇧R`) — strips a page to its article
- Link hints (`⌘E`) — label every link on screen, type the label to
  follow it
- Per-site zoom, remembered across restarts
- Downloads, saved to `~/Downloads` without clobbering existing files

**The rest**
- **Snooze and sweep:** snooze a tab until later (⌥⌘S), and archive tabs you haven't touched in weeks when twig suggests it ([details](docs/snooze.md))
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

## Getting started

The first launch opens a short welcome: a name for new tabs to greet you
by, bookmark import from Chrome, Arc, Brave, Edge or Vivaldi, a look,
how many tabs stay awake, and your shortcuts. Every step is skippable,
and it's replayable any time from Settings or `⌘K` → *Welcome to twig*.
Nothing in it creates an account or leaves the Mac. (Safari isn't in the
import list: its bookmarks need Full Disk Access.)

## Shortcuts

These are the defaults. Every one can be rebound from Settings →
Shortcuts or `⌘K` → *Customize keyboard shortcuts*.

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
| `⇧⌘S` | Save current space as a checkpoint |
| `⇧⌘H` | Browse checkpoints |
| `⌥⌘P` | Package the current space |
| `⇧⌘P` | Research package library and import |
| `⇧⌘F` | Recall a passage |
| `⌥⌘S` | Snooze tab |
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

### Checks

```sh
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
```

The test suite uses Node's built-in SQLite module; use Node 22.13+ for tests.

## Status

Working daily driver, rough in places. Reader view is a heuristic and
will occasionally pick the wrong block; downloads are a notification
rather than a manager. See [CONTRIBUTING.md](CONTRIBUTING.md) if you'd
like to help out.

## License

MIT — see [LICENSE](LICENSE).
