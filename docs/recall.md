# Recall

Recall searches plain-text reading copies captured from pages visited in a
regular Twig window. Open it with **Shift–Command–F**, the toolbar's Recall
button, the new-tab page, or the command palette.

Type words you remember. Search uses SQLite FTS5 word matching and English
stemming; it does not interpret natural-language date requests. Choose a
space and calendar dates to narrow the results. The end date includes the
whole selected day in your local timezone. Results show up to 100 matching
copies; narrower dates and words help locate older copies in a large set.

## Reading and reopening

Selecting a result shows its saved plain text, with matching words marked.
No website is loaded to read a saved copy. Copies contain text only: no
images, scripts, cookies, form state, or executable page markup.

“Open live page at passage” creates a new tab and tries to select the
passage after the site loads. The attempt is bounded to 12 tries over about
six seconds. Redirects, rewritten text, and dynamic layouts can prevent a
match; the saved reading copy remains available in Recall. Original tabs
are not replaced.

“Captured around then” lists up to eight other captures from the same
recorded space and browser session, within 30 minutes of the selected
copy. This is time context, not an AI judgment of relevance. Old migrated
copies with no session metadata have no inferred context.

## Capture and retention

On page load, Twig captures up to 40,000 characters of rendered text from
HTTP(S) pages without embedded credentials. Capture omits forms, editable
documents and controls, scripts, styles, hidden elements, and private
windows. Space ID/name, session, and capture time are attached from the
owning tab before asynchronous extraction. Stale results from a different
navigation are discarded.

Capture has traversal limits, so very large pages, embedded frames, shadow
DOM, or content loaded later may be incomplete. It is a reading aid, not
a full archival copy of a website. Authenticated, non-editable text that
is visible in a regular window can be captured; use a private window when
you do not want page text saved.

Changed versions are preserved independently. An identical URL/title/body
in the same space within 15 minutes is treated as a duplicate, keeping the
original capture time. New captures pause at 2,000 saved copies, with an
error notice in Recall. Existing copies are not automatically evicted.
Legacy collections already exceeding that limit are preserved.

## Forgetting

- **Delete this copy** removes only the selected dated copy.
- **Forget this page** removes every saved copy of that exact address.
- Deleting a history entry also removes all reading copies for its address.
- **Settings → Clear history** clears both history and Recall copies.

Deletion updates the search index and rejects delayed extractions from
before the deletion, so pending capture callbacks cannot immediately
restore forgotten text. Manage history from a regular window. Open tabs,
bookmarks, checkpoints, and explicitly saved research packages are kept.
This is logical deletion from SQLite, not a promise of forensic erasure.

## Existing data

Database migration 5 copies all records from the old `page_text` index
into `recall_captures`, preserving their bodies and timestamps, and builds
`recall_fts` with insert/update/delete triggers. The old index recorded no
space or session, so those fields remain unknown. Historical versions
already overwritten by the old index cannot be recovered. Migration
preserves existing captured text as-is; the new visibility and editable
content exclusions apply to future captures.

## Changes since you last read

When a page you've read before loads again, twig compares its text with the most recent saved copy, from any space, before saving the new one. If paragraphs were added, removed or rewritten, a **Changed · date** chip appears in the address bar. Click it, or use ⌘K → "Show what changed", to see the differences in a panel beside the page. You can also compare against any older copy.

The chip stays quiet when:
- the only differences are relative times, counters or clock times ("3 hours ago", "1.2k views");
- the saved copy is less than 10 minutes old, as with a reload;
- one copy is under 30% the length of the other, which usually means a partial load;
- the page has changed wholesale three visits running, as a feed does;
- you've muted the site from the panel.

Muted sites are listed in **Settings → Data**. Nothing is fetched in the background: changes are noticed only when you open the page yourself.

## Verification

`npm test` exercises the migration and queries against real SQLite FTS5,
including immutable versions, filters, context, deletion, late-callback
ordering, capacity, and failed-write recovery. It also checks date bounds
and safe text highlighting. Tests require Node 22.13 or newer for
`node:sqlite`; the application build retains its existing Node requirement.
Native tests cover URL validation, metadata ownership, privacy gates, and
passage serialization. Live WKWebView capture and passage selection remain
dependent on website behavior.

The optional `npm run test:recall-browser` check uses an existing Playwright
installation and a running `npm run dev` server. Set `TWIG_PLAYWRIGHT_MODULE`
to the file URL of that installation's `index.mjs` when it is outside the
project. Playwright and its browser are test tooling, not new application
dependencies. `PLAYWRIGHT_BROWSERS_PATH` or `TWIG_BROWSER_EXECUTABLE` can
point to an existing test browser; `TWIG_TEST_URL` overrides the local
server address. Set `CAPTURE=1` to write screenshots into a reported temp
directory. This check runs the actual capture script on editable/hidden
fixtures and connects the frontend to in-memory SQLite. Native webview
creation is mocked, so it does not replace a live macOS test.
