export type PresetId = "hour" | "evening" | "tomorrow" | "weekend" | "week";
export interface SnoozePreset { id: PresetId; label: string; detail: string; at: number }

const MINUTE = 60_000;
const DAY = 86_400_000;

/** `base`'s calendar day moved by `days`, at `hour`:00 local. Local-field
 *  setters, so month ends and DST land on the wall-clock hour asked for. */
function dayAt(base: Date, days: number, hour: number): Date {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Days until the next `weekday` strictly after today (0 = Sunday). */
function daysUntil(today: number, weekday: number): number {
  const n = (weekday - today + 7) % 7;
  return n === 0 ? 7 : n;
}

export function snoozePresets(now: Date): SnoozePreset[] {
  const late = now.getHours() >= 17;
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  const presets: Omit<SnoozePreset, "detail">[] = [
    { id: "hour", label: "In 1 hour", at: now.getTime() + 60 * MINUTE },
    { id: "evening", label: late ? "Tomorrow evening" : "This evening", at: dayAt(now, late ? 1 : 0, 18).getTime() },
    { id: "tomorrow", label: "Tomorrow morning", at: dayAt(now, 1, 9).getTime() },
    { id: "weekend", label: weekend ? "Next weekend" : "This weekend", at: dayAt(now, daysUntil(now.getDay(), 6), 9).getTime() },
    { id: "week", label: "Next week", at: dayAt(now, daysUntil(now.getDay(), 1), 9).getTime() },
  ];
  return presets.map((p) => ({ ...p, detail: wakeLabel(p.at, now.getTime()) }));
}

/** A `datetime-local` value as a wake time, or null unless it's at least a
 *  minute from now. */
export function customWakeAt(value: string, now: number): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) && at >= now + MINUTE ? at : null;
}

export function dateTimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** How long the wake clock sleeps. Capped at a minute so a laptop that
 *  slept through a wake time catches up soon after it opens. */
export function nextDelay(nextWakeAt: number | null, now: number): number {
  if (nextWakeAt === null) return MINUTE;
  return Math.min(Math.max(nextWakeAt - now, 0), MINUTE);
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function wakeLabel(at: number, now: number): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days > 1 && days < 7) return `${when.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return `${when.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}
