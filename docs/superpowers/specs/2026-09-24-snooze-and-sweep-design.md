# Snooze tabs and sweep stale ones: design

## Intent

People hoard tabs because a tab is the only "I'm in the middle of this" marker a browser gives them. twig should let you **snooze** a tab: it leaves the strip and comes back by itself at a time you pick. It should also notice tabs you haven't touched in weeks and **offer** to archive them. Nothing is lost either way: snoozed tabs return, and archived tabs stay findable in Library → Closed tabs.

**Agreed with the owner:**
- Snooze and sweep ship together.
- A snooze is a real close plus a scheduled reopen. There are no hidden tabs in Rust state.
- Woken tabs return asleep, at the end of their original space, with a "back" dot. They never steal focus.
- The sweep only suggests. You confirm archiving in a review panel.

**Success looks like this:**
- Snoozing a tab "In 1 hour" removes it from the strip. An hour later it's back in the same space with a dot, and your current tab didn't change.
- Snoozing, then quitting twig before the wake time and relaunching after it, brings the tab back on launch.
- With the threshold at 1 week, tabs untouched for 8 days show up in `N untouched tabs`. Archiving them moves them to Closed tabs.

## Non-goals

- macOS notifications when a tab wakes.
- Recurring snoozes, or snoozing a whole space.
- Keeping back/forward history or scroll position across a snooze.
- Snoozing or sweeping in private windows.
- Sync across machines.

## Architecture

```
TabStrip moon / ⌘K / ⌥⌘S ──▶ SnoozePicker ──▶ snoozeTab(tabId, wakeAt)
                                                 │ insert row in `snoozed`
                                                 │ close_tab (no archive)
                                                 ▼
startSnoozeClock (main window only) ── due rows ──▶ open_background_tab(url, title, groupId)
   timer: min(next wake, 60s), + on focus          │ delete row, mark tab "woken"
                                                   ▼
                                        TabStrip dot until the tab is activated

Rust TabEntry.last_used_ms (persisted) ─▶ TabInfo.lastUsedAt
   staleTabs(tabs, now, threshold) ─▶ sweep pill ─▶ SweepPanel (right inset) ─▶ archive / snooze
```

### Units

1. **`src-tauri/migrations/006_snoozed.sql` + `lib.rs` migration 6**

   ```sql
   CREATE TABLE snoozed (
     id INTEGER PRIMARY KEY,
     url TEXT NOT NULL,
     title TEXT NOT NULL,
     space_id TEXT,
     space_name TEXT,
     wake_at INTEGER NOT NULL,
     snoozed_at INTEGER NOT NULL
   );
   CREATE INDEX idx_snoozed_wake ON snoozed(wake_at);
   ```

2. **Rust `tabs.rs`**
   - **Last-used time.** `TabEntry` gains `last_used_ms: u64`, which is wall-clock milliseconds. It's set to now wherever `last_active_at = Instant::now()` is set today (`wake` and `navigate`) and in `open_tab_with_script`. Waking a tab only counts as use when it's activated or switched to, and that's exactly where `wake` runs. `TabInfo` gains `last_used_at: u64` (`lastUsedAt` in JSON).
   - **Persistence.** `PersistedTab` gains `#[serde(default)] last_used_ms: Option<u64>`. On restore, `None` becomes now, so old sessions never look stale.
   - **New command `open_background_tab(url: String, title: String, group_id: Option<String>) -> TabInfo`:**
     - Validates that the URL is http(s).
     - Pushes a `TabEntry` with `status: Hibernated`, no webview, `scroll_y: 0` and `last_used_ms = now`.
     - Places it in `group_id` if that space still exists, otherwise in the active space.
     - Doesn't change active or split, hide anything, or move focus. It saves the session and emits `tabs-changed`.
     - The command is registered in `lib.rs`.
   - **Unit test:** a session JSON without `last_used_ms` deserializes, and the tab gets a last-used time close to now.

3. **Keymap.** `a("snooze-tab", "Snooze Tab…", "Tab", "CmdOrCtrl+Alt+KeyS", false)`. It isn't reserved: `RESERVED` holds ⌥⌘H and ⌘1–9.

4. **`src/lib/snooze.ts`: pure, unit tested**
   - `snoozePresets(now: Date): SnoozePreset[]`, where each preset is `{ id, label, detail, at }` and `detail` is the formatted local time:
     - `hour`: now + 60 minutes, labelled "In 1 hour".
     - `evening`: today 18:00 if now is before 17:00, otherwise tomorrow 18:00. Labelled "This evening" or "Tomorrow evening".
     - `tomorrow`: tomorrow 09:00, "Tomorrow morning".
     - `weekend`: the next Saturday strictly after today, 09:00. "This weekend" Monday to Friday, "Next weekend" on Saturday or Sunday.
     - `week`: the next Monday strictly after today, 09:00, "Next week".
   - All date math uses local-field setters (`setDate`, `setHours`), so DST and month ends roll over correctly.
   - `customWakeAt(value: string, now: number): number | null` parses a `datetime-local` value and returns null unless it's at least 1 minute in the future.
   - `nextDelay(nextWakeAt: number | null, now: number): number` returns `min(max(nextWakeAt - now, 0), 60_000)`, or `60_000` when nothing is pending.
   - `wakeLabel(at: number, now: number): string` gives strings like "today 6:00 PM", "tomorrow 9:00 AM", "Sat 9:00 AM" (within 6 days), or "Oct 3, 9:00 AM".

5. **`src/lib/snooze-db.ts`**
   - `addSnooze({ url, title, spaceId, spaceName, wakeAt }): Promise<number>`
   - `dueSnoozes(now): Promise<SnoozedTab[]>`, ordered by `wake_at`
   - `listSnoozes(): Promise<SnoozedTab[]>`, ordered by `wake_at`
   - `nextWakeAt(): Promise<number | null>`
   - `deleteSnooze(id): Promise<void>`
   - `SnoozedTab = { id, url, title, spaceId, spaceName, wakeAt, snoozedAt }`
   - Unit tested against real SQLite with the migration, like `recall-db.test.mjs`.

6. **`src/lib/sweep.ts`: pure, unit tested**
   - `staleTabs(tabs: Tab[], activeId, splitId, now, thresholdDays): Tab[]`. A tab is stale when `lastUsedAt < now - thresholdDays·86_400_000` and it isn't the active tab or the split partner. Tabs from all spaces count, and the oldest come first. It returns `[]` when `thresholdDays` is 0 (off).
   - `shouldSuggest(stale: Tab[], dismissedUntil: number, now): boolean` is true when `stale.length >= 3 && now >= dismissedUntil`.
   - `SWEEP_CHOICES = [0, 7, 21, 30]`, default 21, and `DISMISS_FOR = 7 days`.

7. **Store `src/store/snooze.ts` (Zustand)**
   - `pickerFor: string | null`, the tab ID whose picker is open.
   - `woken: Record<string, true>`, tab IDs that came back and haven't been looked at.
   - `sweepOpen: boolean`
   - `sweepDays: number`, stored in localStorage as `twig:sweep-days`, default 21.
   - `dismissedUntil: number`, stored as `twig:sweep-dismissed-until`.
   - Actions: `openPicker(id)`, `closePicker()`, `markWoken(id)`, `seen(id)`, `setSweepDays(n)`, `dismiss(now)`, `openSweep()`, `closeSweep()`.
   - localStorage access is wrapped in try/catch.

8. **`src/lib/snooze-actions.ts`: the glue**
   - `snoozeTab(tabId, wakeAt)` reads the tab and its space name from `useTabStore`. It refuses internal or empty URLs, private windows, and `wakeAt <= now`. It calls `addSnooze`, then `closeTab(tabId)` directly, bypassing `useTabStore.close` so the tab isn't archived. If the insert fails, the tab isn't closed. It then emits `twig:snoozed-changed`.
   - `wakeDue()` calls `open_background_tab` for each due row, then `deleteSnooze(row.id)` and `markWoken(tab.id)`. If opening fails, the row is kept and retried on the next tick. It emits `twig:snoozed-changed`.
   - `startSnoozeClock(): () => void` runs only when `getCurrentWindow().label === "main"`. It calls `wakeDue()` immediately, then schedules a timeout of `nextDelay(await nextWakeAt(), Date.now())`. It also re-runs on window `focus` and on `twig:snoozed-changed`. A single in-flight guard prevents overlapping runs.
   - `wakeNow(id)` opens the tab in the background, deletes the row, then calls `switchTo` on the new tab.
   - `cancelSnooze(row)` calls `archiveTab(url, title)`, then `deleteSnooze`, so the tab stays findable.
   - Watcher: `useTabStore.subscribe` clears `woken[id]` when `id` becomes active or the tab disappears.

9. **UI**
   - **TabStrip**
     - A `tab-action tab-snooze` button with a moon icon, placed between split and close. It's hidden on new-tab and internal pages and in private windows, and has the title "Snooze (⌥⌘S)".
     - A `tab-woke` moss dot before the title when `woken[id]`, titled "Back from snooze".
     - At the right end, before the + button, a `sweep-pill` button reading `N untouched tabs`, shown when `shouldSuggest`. It's recomputed on tabs-changed, on a 1-hour interval, and when the settings change. It isn't shown in private windows.
   - **`SnoozePicker.tsx`**
     - A modal `<dialog>` centred under the tab strip. It uses `setOverlayActive(true, "snooze")` and sets `inert` on its siblings, the same way `Welcome` does.
     - Heading "Snooze until…" and the tab title.
     - Six rows: the presets plus "Pick a date and time…", which reveals a `datetime-local` input and a "Snooze" button. Each row shows its key (1–6) and its time.
     - Keys: ↑/↓ and Enter pick, 1–6 choose directly, and Esc closes.
     - It opens from the tab button, from ⌘K "Snooze tab…" (only when the active tab can be snoozed), and from the `snooze-tab` menu action on the active tab.
   - **`SweepPanel.tsx`**
     - A right-side panel 380px wide, using `setContentInset(380)` with the same narrow-window overlay fallback as the Changes panel. Opening it closes the Changes panel, and opening the Changes panel closes it. The same z-index and placement as Changes.
     - Heading "Tabs you haven't touched", with the subline "Untouched for N days or more".
     - A checkbox list, all checked, where each row shows the site mark, title, space name and "last used Sep 3".
     - Buttons:
       - **Archive selected** runs `useTabStore.close(id)` for each, so tabs go into the archive, then closes the panel.
       - **Snooze selected to next week** snoozes each with the `week` preset's time.
       - **Not now** calls `dismiss(now)` and closes the panel.
     - Esc closes it. It uses the aside role with `aria-label="Untouched tabs"`.
   - **Library.** A new `Snoozed` segment. Rows show the title, host and "Wakes Sat 9:00 AM", with the actions **Wake now** and **Cancel**, where cancelling moves the tab to Closed tabs. The empty state reads "Nothing snoozed. Snooze a tab from its moon button or ⌥⌘S." It refreshes on `twig:snoozed-changed`.
   - **Settings → Memory**, after "Tabs kept awake": a "Suggest archiving tabs untouched for" segmented control with Off, 1 week, 3 weeks and 1 month.
   - **Palette.** "Snooze tab…" plus "Review untouched tabs" when the pill would show. `COMMAND_MENU_IDS` maps `cmd-snooze` to `snooze-tab`.

## Error handling

- If `addSnooze` fails, the tab stays open and the picker shows the error inline.
- If `open_background_tab` fails, the row stays and is retried. After it fails 3 times in a row for the same row ID, the tab goes to the archive and the row is deleted, so it can't loop forever. Failure counts are kept in memory.
- If the space no longer exists, Rust falls back to the active space.
- Clock changes, such as a laptop asleep past the wake time, are handled because each tick compares against `Date.now()` and the timer is never longer than 60 seconds.

## Testing

- `tests/snooze.test.mjs`:
  - presets on a Tuesday at 10:00, a Tuesday at 17:30, a Saturday at 08:00 and a Sunday;
  - the end of a month (Jan 31 → Feb 1);
  - the DST spring-forward day, using a local-time assertion on `getHours() === 9`;
  - `customWakeAt` for the past, now + 30 s and valid values;
  - `nextDelay` and `wakeLabel`.
- `tests/sweep.test.mjs`: the threshold, excluding active and split tabs, off = 0, oldest first, and `shouldSuggest` with the minimum count and cooldown.
- `tests/snooze-db.test.mjs`: add, due, next, list and delete against SQLite with migration 006.
- `tests/snooze-store.test.mjs`: sweep settings persistence and junk tolerance, and woken marking and clearing.
- Rust: the `PersistedTab` default test, and `cargo test` for the tabs module.
- `tests/snooze-browser.mjs` (WebKit, mocked Tauri, fake `Date.now`):
  - snooze from the tab moon, then assert the row exists and `close_tab` was invoked with no archive row;
  - advance the clock and assert `open_background_tab` is invoked, the tab appears with `.tab-woke`, and activating it clears the dot;
  - the Snoozed shelf lists a pending row, and Cancel archives it;
  - with the sweep at 7 days and 4 tabs whose `lastUsedAt` is 10 days old, the pill reads "4 untouched tabs"; opening the panel and choosing Archive selected closes 4 tabs and writes 4 archive rows;
  - Not now hides the pill;
  - `CAPTURE=1` saves screenshots.
- Before committing: `npm test`, `npm run build`, and `cargo check` plus `cargo test` in `src-tauri`.

## Docs

- A README feature entry, "Snooze and sweep".
- `docs/snooze.md`, covering behavior and limits: tabs lose their history, wakes happen in the main window, and missed wakes fire on launch.
