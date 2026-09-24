# Snooze and sweep

## Snooze

Snooze a tab from the moon button on the tab (on hover), **⌥⌘S**, or ⌘K → "Snooze tab…". Pick one of:

- In 1 hour
- This evening (6 PM, or tomorrow evening after 5 PM)
- Tomorrow morning (9 AM)
- This weekend (Saturday 9 AM)
- Next week (Monday 9 AM)
- A date and time you choose

The tab closes right away without going to Closed tabs. When its time comes, it comes back asleep at the end of its original space, with a small dot until you look at it. If that space is gone, it comes back to the space you're in. It never switches your tab or space.

The tab comes back as a fresh load of its address. Back/forward history and scroll position aren't kept.

If twig is closed at the wake time, the tab comes back the next time twig starts. twig checks at least once a minute, so after a laptop sleeps through a wake time, the tab reappears within about a minute of waking. Only the main window brings tabs back, and private windows can't snooze.

**Library → Snoozed** lists what's waiting. Click a row to bring it back now. Cancelling moves the tab to Closed tabs rather than deleting it. A tab that fails to reopen three times in a row also goes to Closed tabs.

## Sweep

twig records when each tab was last on screen, and keeps that across restarts. When three or more tabs have gone untouched past your threshold, a quiet **N untouched tabs** pill appears in the tab strip. Nothing happens until you open it.

The panel lists them oldest first, all checked, with three options:

- **Archive** closes the checked tabs into Library → Closed, where they're searchable.
- **Snooze to next week** snoozes them all.
- **Not now** hides the pill for a week.

The tab on screen, and its split partner, are never counted. Set the threshold in **Settings → Memory**: Off, 1 week, 3 weeks (the default) or 1 month. Tabs from before this feature count as used on the day you upgraded.
