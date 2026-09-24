# Page change detection: design

## Intent

When you come back to a page you've read before and it has changed, twig tells you so and shows you what changed. This is the first feature built on the "twig remembers" positioning. The storage already exists: Recall keeps an immutable dated copy (`recall_captures`) every time a page's text changes.

**Agreed with the owner:**
- Detection happens **only on revisit**. twig makes no background fetches and keeps no watch list.
- The signal is a quiet **chip in the address bar**. Clicking it opens a **right-side diff panel**, and the page stays visible to its left.

**Success looks like this:**
- Revisiting a docs page that gained a paragraph shows `● Changed · <date>`, and the panel shows that paragraph as added.
- Reloading a page, or visiting a news homepage, does not light up the chip.

## Non-goals

- Background re-checking, watch lists, and system notifications.
- Diffing images, layout or markup. Only captured text is compared.
- Changing how Recall captures or stores copies, beyond reading from them.

## Architecture

```
Rust capture ──page-captured {tab_id, url, body…}──▶ App.tsx
                                                      │
                          ┌───────────────────────────┤
                          ▼                           ▼
             detectChange(url, body)            indexRecall (unchanged)
             (reads latest prior copy
              BEFORE the insert, via the
              recall write queue)
                          │
                          ▼
             useChangeStore: tabId → PageChange | null
                          │
             AddressBar chip ──click──▶ <Changes/> panel
                                          │ diffCopies(old, new)
                                          │ set_content_inset(right)
```

### Units

1. **`src/lib/changes.ts`**: pure logic, no I/O, unit tested.
   - `normalize(body): string[]` splits the text into paragraphs on `\n`, trims them, collapses whitespace and drops empty ones. It masks volatile tokens for *comparison only*: relative times ("3 hours ago", "5m ago", "yesterday"), counters ("1.2k views", "42 comments", "123 likes") and clock times. The displayed text keeps the originals.
   - `diffCopies(oldBody, newBody): DiffResult` runs a paragraph-level diff over the normalized keys, then maps the result back to the original paragraphs. When a removed paragraph sits directly before an added one, the pair becomes one **edited** passage with word-level parts. The result has `passages: Passage[]`, where each passage is `{kind: "added" | "removed" | "edited" | "context", parts}`. It also has `added`, `removed` and `edited` counts, and `changedRatio`, the share of paragraphs touched on the larger side.
   - `hunks(result, context = 1)` keeps the changed passages plus one unchanged paragraph of context on either side, and marks the gaps between them.
   - `isMeaningful(result, oldBody, newBody): boolean` is false in three cases: no passages are added, removed or edited; either body is under 30% of the other's length, which suggests a partial or lazy capture; or the only differences were in masked tokens.
   - `isVolatile(ratios: number[]): boolean` is true when the last 3 ratios between consecutive prior copies are all above 0.5.
   - `hostOf(url)` returns the host for per-site muting.
   - The diff uses the `diff` npm package (jsdiff): `diffArrays` for paragraphs and `diffWordsWithSpace` for edited pairs.

2. **`src/lib/recall-db.ts`**: new reads that go through the existing `write` queue and `await writes`, so they can't interleave with an insert or a forget.
   - `copiesBefore(url, before, limit = 3)` returns up to `limit` copies of the URL from any space with `captured_at < before`, newest first. The first is the baseline; the rest feed the volatility check.
   - `copiesOf(url)` returns `{id, capturedAt}[]` for the "Compare with…" menu, newest first.
   - `indexRecall` is unchanged.

3. **`src/store/changes.ts`**: a Zustand store.
   - `byTab: Record<tabId, PageChange>`, where `PageChange = {url, baselineId, baselineAt, currentBody, summary: {added, removed, edited}}`.
   - Actions: `set(tabId, change)`, `clear(tabId)`, `open(tabId)`, `close()` and `openFor: tabId | null`.
   - Muted hosts live in `localStorage["twig:changes-muted"]`, a JSON string array. Every read and write is wrapped in try/catch.

4. **Detection flow (`App.tsx` `page-captured` handler)**, run before `indexPage`:
   1. Skip if the window is private, the host is muted, or the payload has no `tab_id`.
   2. Fetch `copies = copiesBefore(url, captured_at, 3)`; `copies[0]` is the baseline. If there's none, clear and stop. If it's under 10 minutes older than this capture, leave the tab's current change as it is (a reload) and stop.
   3. Run `diffCopies(baseline.body, body)`. If the result isn't meaningful, clear and stop.
   4. Volatility uses this change's ratio plus the ratios between consecutive earlier copies. If `isVolatile`, clear and stop.
   5. Otherwise call `set(tab_id, …)`.

   Detection errors are swallowed and logged to the console. They must never block indexing. Then call `indexPage(payload)` exactly as today.

5. **Clearing.** A tab's change is cleared on a `tabs-changed` event whose URL differs from `change.url`, and when the tab closes. It's also cleared on `twig:recall-changed` if the baseline copy no longer exists, for example after "Forget this page".

6. **Rust: `tab_id` on the payload.** Add `tab_id: String` to `IndexedPage` in `src-tauri/src/tabs.rs` and fill it from `capture_id`. Add optional `tabId` to the TS `RecallCapture` payload type. `indexRecall` ignores it.

7. **Rust: `set_content_inset(right: f64)`.** This mirrors `set_content_offset`: a `content_inset_right` field on `Inner`, subtracted from the width in `content_bounds` and `split_bounds`, with no-op early return when unchanged, and applied to every tab and split webview in the window. Register it in `lib.rs`. On the frontend, a `setContentInset(px)` wrapper goes in `src/lib/tabs.ts`.

8. **Chip (`AddressBar.tsx`).** The chip is `useChangeStore(s => activeId ? s.byTab[activeId] : undefined)`, a narrow selector. It's a `<button class="change-chip">` with a moss dot, `Changed · Sep 12`, and `title="Changed since you read it on <full date>"`. It sits just before the bookmark star. It doesn't show when a panel of another kind is open, or on internal pages.

9. **Panel (`src/components/Changes.tsx` + `Changes.css`)**
   - Opens from the chip, from the ⌘K command "Show what changed" (hidden when the active tab has no change), and from the menu action `show-changes`, which has no default accelerator.
   - Layout: a 380px panel on the right, full height below the chrome. On open it calls `setContentInset(380)`, and `setContentInset(0)` on close or unmount. Below 880px window width it falls back to the overlay (`setOverlayActive(true, "changes")`) and full width.
   - Header: "What changed since you read it", `Sep 12 → today`, and counts `+3 · −1 · ~2`.
   - Body: hunks from `hunks()`. Added passages get a moss left rule and tint; removed passages get a muted strikethrough; edited passages show inline `<ins>`/`<del>` word marks; context is muted. Gaps render as "⋯ N unchanged paragraphs".
   - Footer:
     - "Compare with…" is a `<select>` of older copies from `copiesOf(url)`. Picking one re-diffs against that copy's body, fetched with `getRecallCopy`.
     - "Don't flag changes on <host>" mutes the host, clears the chip and closes the panel.
     - "Open in Recall" opens Recall.
   - Behavior: Esc closes it, focus moves to the panel heading on open and back to the chip on close, and it has `role="complementary"` with `aria-label="Changes to this page"`.
   - It uses existing tokens (`--accent`, `--text-muted`, `var(--ease)`). Motion is a transform/opacity slide-in only, and it respects `prefers-reduced-motion`.

10. **Settings (`SettingsPanel.tsx`).** Under the Recall/privacy area, a "Change alerts muted on" list shows each host with a remove button. It's hidden when the list is empty.

## Error handling

- DB read failures during detection are logged. The chip isn't shown and indexing proceeds.
- The panel shows "This copy is no longer saved." if `getRecallCopy` returns null, which happens when it was forgotten while the panel was open.
- Diffing runs synchronously. Input is at most 40k characters, about 1k paragraphs, and jsdiff's `diffArrays` handles that in single-digit milliseconds. No worker is needed.

## Testing

- **`tests/changes.test.mjs`** (node:test, like the existing tests). It covers:
  - normalization and masking: "3 hours ago" vs "4 hours ago" is not meaningful;
  - added, removed and edited detection and counts;
  - the partial-capture length guard;
  - the volatility rule;
  - `hunks` context and gap counts;
  - `hostOf`.
- **`tests/recall-db.test.mjs`** additions: `copiesBefore` ignores copies at or after `before` and spans spaces; `copiesOf` ordering.
- **`tests/changes-browser.mjs`** (WebKit, mocked Tauri, like `welcome-browser.mjs`):
  - seed an old copy, emit a `page-captured` with changed text, then assert the chip appears;
  - open the panel and assert the passages and that `set_content_inset(380)` was invoked;
  - assert that Esc closes it;
  - assert that mute clears the chip;
  - `CAPTURE=1` saves screenshots.
- Before committing: `npm test`, `npm run build`, and `cargo check`.

## Docs

Add a "Changes since you last read" section to `docs/recall.md` and a line to the README feature list.
