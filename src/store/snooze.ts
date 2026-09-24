import { create } from "zustand";
import { DEFAULT_SWEEP_DAYS, DISMISS_FOR, SWEEP_CHOICES } from "../lib/sweep";

const DAYS_KEY = "twig:sweep-days";
const DISMISS_KEY = "twig:sweep-dismissed-until";

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: lasts this session */ }
}
function loadDays(): number {
  const raw = read(DAYS_KEY);
  const days = Number(raw);
  return raw !== null && (SWEEP_CHOICES as readonly number[]).includes(days) ? days : DEFAULT_SWEEP_DAYS;
}
function loadDismissed(): number {
  const until = Number(read(DISMISS_KEY));
  return Number.isFinite(until) ? until : 0;
}

interface SnoozeStore {
  /** Tab whose snooze picker is open. */
  pickerFor: string | null;
  /** Tabs that came back from a snooze and haven't been looked at yet. */
  woken: Record<string, true>;
  sweepOpen: boolean;
  sweepDays: number;
  dismissedUntil: number;
  openPicker: (id: string) => void;
  closePicker: () => void;
  markWoken: (id: string) => void;
  seen: (id: string) => void;
  setSweepDays: (days: number) => void;
  dismiss: (now: number) => void;
  openSweep: () => void;
  closeSweep: () => void;
}

export const useSnoozeStore = create<SnoozeStore>((set, get) => ({
  pickerFor: null,
  woken: {},
  sweepOpen: false,
  sweepDays: loadDays(),
  dismissedUntil: loadDismissed(),
  openPicker: (id) => set({ pickerFor: id }),
  closePicker: () => set({ pickerFor: null }),
  markWoken: (id) => set((s) => ({ woken: { ...s.woken, [id]: true } })),
  seen: (id) => {
    if (!get().woken[id]) return;
    set((s) => {
      const woken = { ...s.woken };
      delete woken[id];
      return { woken };
    });
  },
  setSweepDays: (days) => {
    write(DAYS_KEY, String(days));
    set({ sweepDays: days });
  },
  dismiss: (now) => {
    const until = now + DISMISS_FOR;
    write(DISMISS_KEY, String(until));
    set({ dismissedUntil: until, sweepOpen: false });
  },
  openSweep: () => set({ sweepOpen: true }),
  closeSweep: () => set({ sweepOpen: false }),
}));
