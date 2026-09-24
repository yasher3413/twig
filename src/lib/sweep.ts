import type { Tab } from "./tabs";

export const DAY = 86_400_000;
export const SWEEP_CHOICES = [0, 7, 21, 30] as const;
export const DEFAULT_SWEEP_DAYS = 21;
export const DISMISS_FOR = 7 * DAY;
/** Fewer than this isn't a pile worth interrupting anyone about. */
export const MIN_STALE = 3;

/** Tabs untouched for `thresholdDays` or more, oldest first. What's on
 *  screen is never stale, however long it has sat there. */
export function staleTabs(tabs: Tab[], activeId: string | null, splitId: string | null, now: number, thresholdDays: number): Tab[] {
  if (thresholdDays <= 0) return [];
  const cutoff = now - thresholdDays * DAY;
  return tabs
    .filter((t) => t.id !== activeId && t.id !== splitId && t.lastUsedAt < cutoff)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
}

export function shouldSuggest(stale: Tab[], dismissedUntil: number, now: number): boolean {
  return stale.length >= MIN_STALE && now >= dismissedUntil;
}

export function sweepChoiceLabel(days: number): string {
  return days === 0 ? "Off" : days === 7 ? "1 week" : days === 30 ? "1 month" : `${days / 7} weeks`;
}
