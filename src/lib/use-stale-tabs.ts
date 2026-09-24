import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTabStore } from "../store/tabs";
import { useSnoozeStore } from "../store/snooze";
import { staleTabs } from "./sweep";
import type { Tab } from "./tabs";

/** Tabs worth offering to archive, re-checked hourly and on every change. */
export function useStaleTabs(): Tab[] {
  const { tabs, activeId, splitId, isPrivate } = useTabStore(
    useShallow((s) => ({ tabs: s.tabs, activeId: s.activeId, splitId: s.splitId, isPrivate: s.isPrivate })),
  );
  const days = useSnoozeStore((s) => s.sweepDays);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 3_600_000);
    return () => window.clearInterval(timer);
  }, []);
  return useMemo(
    () => (isPrivate ? [] : staleTabs(tabs, activeId, splitId, now, days)),
    [tabs, activeId, splitId, now, days, isPrivate],
  );
}
