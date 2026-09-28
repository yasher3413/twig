import { isInternalUrl, type Tab } from "./tabs";

export interface Visit { url: string; title: string }

/** What one tabs-changed means for history: a visit for every tab that is
 *  now showing a different page (link clicks and redirects included, not
 *  just what was typed), and a retitle for pages that have since named
 *  themselves. Waking or reordering a tab changes neither. */
export function visitChanges(before: Tab[], after: Tab[]): { visits: Visit[]; retitles: Visit[] } {
  const previous = new Map(before.map((t) => [t.id, t]));
  const visits: Visit[] = [];
  const retitles: Visit[] = [];
  for (const tab of after) {
    if (!tab.url || isInternalUrl(tab.url)) continue;
    // A tab that arrives asleep (a woken snooze, a restored checkpoint)
    // hasn't loaded anything, so nobody has visited it yet.
    if (tab.status === "hibernated" && !previous.has(tab.id)) continue;
    const was = previous.get(tab.id);
    if (!was || was.url !== tab.url) visits.push({ url: tab.url, title: tab.title });
    else if (was.title !== tab.title) retitles.push({ url: tab.url, title: tab.title });
  }
  return { visits, retitles };
}
