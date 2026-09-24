import { getCurrentWindow } from "@tauri-apps/api/window";
import { addSnooze, deleteSnooze, dueSnoozes, nextWakeAt, type SnoozedTab } from "./snooze-db";
import { archiveTab } from "./db";
import { closeTab, isInternalUrl, openBackgroundTab } from "./tabs";
import { nextDelay } from "./snooze";
import { useTabStore } from "../store/tabs";
import { useSnoozeStore } from "../store/snooze";

const MAX_FAILURES = 3;
const failures = new Map<number, number>();

function changed() {
  window.dispatchEvent(new Event("twig:snoozed-changed"));
}

export function canSnooze(tabId: string | null): boolean {
  const s = useTabStore.getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  return !!tab && !s.isPrivate && !isInternalUrl(tab.url) && /^https?:/.test(tab.url);
}

/** Closes the tab - without sending it to Closed tabs - once its return
 *  is written down. If the write fails the tab stays open. */
export async function snoozeTab(tabId: string, wakeAt: number): Promise<void> {
  const s = useTabStore.getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab || !canSnooze(tabId)) throw new Error("This tab can't be snoozed.");
  if (!(wakeAt > Date.now())) throw new Error("Pick a time in the future.");
  const space = s.groups.find((g) => g.id === tab.groupId);
  await addSnooze({ url: tab.url, title: tab.title, spaceId: tab.groupId, spaceName: space?.name ?? null, wakeAt });
  changed();
  await closeTab(tabId);
}

let waking: Promise<void> | null = null;

/** Single-flight across the module: two clocks (StrictMode's double mount,
 *  a hot reload) must never both read a due row before either deletes it,
 *  or the tab comes back twice. */
export function wakeDue(now = Date.now()): Promise<void> {
  waking ??= wakeDueOnce(now).finally(() => { waking = null; });
  return waking;
}

async function wakeDueOnce(now: number): Promise<void> {
  let touched = false;
  for (const row of await dueSnoozes(now)) {
    try {
      const tab = await openBackgroundTab(row.url, row.title, row.spaceId);
      await deleteSnooze(row.id);
      failures.delete(row.id);
      useSnoozeStore.getState().markWoken(tab.id);
      touched = true;
    } catch (cause) {
      const count = (failures.get(row.id) ?? 0) + 1;
      failures.set(row.id, count);
      console.warn("Couldn't bring back a snoozed tab", row.url, cause);
      if (count >= MAX_FAILURES) {
        // Give up on reopening, but never lose it: it's in Closed tabs now.
        await archiveTab(row.url, row.title).catch(() => {});
        await deleteSnooze(row.id).catch(() => {});
        failures.delete(row.id);
        touched = true;
      }
    }
  }
  if (touched) changed();
}

export async function wakeNow(row: SnoozedTab): Promise<void> {
  const tab = await openBackgroundTab(row.url, row.title, row.spaceId);
  await deleteSnooze(row.id);
  changed();
  await useTabStore.getState().switchTo(tab.id);
}

/** Not coming back after all - but still findable, in Closed tabs. */
export async function cancelSnooze(row: SnoozedTab): Promise<void> {
  await archiveTab(row.url, row.title);
  await deleteSnooze(row.id);
  changed();
}

/** Wakes due tabs now, then again whenever the next one is due - never
 *  sleeping over a minute, never faster than a second. Main window only,
 *  so a private window can't bring a tab back twice. */
export function startSnoozeClock(): () => void {
  if (getCurrentWindow().label !== "main") return () => {};
  let timer: number | undefined;
  let running = false;
  let stopped = false;
  async function tick() {
    if (running || stopped) return;
    running = true;
    window.clearTimeout(timer);
    try { await wakeDue(); } catch (cause) { console.warn("Snooze clock failed", cause); }
    let next: number | null = null;
    try { next = await nextWakeAt(); } catch { /* retry on the next tick */ }
    running = false;
    if (!stopped) timer = window.setTimeout(tick, Math.max(1000, nextDelay(next, Date.now())));
  }
  const kick = () => void tick();
  window.addEventListener("focus", kick);
  window.addEventListener("twig:snoozed-changed", kick);
  kick();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.removeEventListener("focus", kick);
    window.removeEventListener("twig:snoozed-changed", kick);
  };
}

/** A woken tab's dot goes once you've looked at it. */
export function watchWoken(): () => void {
  return useTabStore.subscribe((s) => {
    if (s.activeId && useSnoozeStore.getState().woken[s.activeId]) useSnoozeStore.getState().seen(s.activeId);
  });
}
