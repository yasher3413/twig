import { diffArrays, diffWordsWithSpace } from "diff";

export interface WordPart { text: string; kind: "same" | "added" | "removed" }
export type PassageKind = "added" | "removed" | "edited" | "context";
export interface Passage { kind: PassageKind; text: string; words?: WordPart[] }
export interface DiffResult { passages: Passage[]; added: number; removed: number; edited: number; changedRatio: number }
export type Hunk = Passage | { kind: "gap"; count: number };
export interface StoredCopy { id: number; body: string; capturedAt: number }
export interface PageChange {
  url: string;
  capturedAt: number;
  baselineId: number;
  baselineAt: number;
  currentBody: string;
  summary: { added: number; removed: number; edited: number };
}
export type Decision = { action: "keep" } | { action: "clear" } | { action: "set"; change: PageChange };

/** A copy newer than this is a reload, not "what you last read". */
export const BASELINE_MIN_AGE = 10 * 60 * 1000;

// Text that changes on every load without the page meaning anything
// different. Masked for comparison only; the panel shows the real words.
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const COUNTED = "(?:views?|comments?|likes?|replies|reply|points?|stars?|shares?|reactions?|upvotes?|followers?|reads?)";
const VOLATILE: RegExp[] = [
  /\b\d+\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|months?|y|yrs?|years?)\s+ago\b/gi,
  /\b(?:an?|one)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi,
  /\b(?:just now|yesterday|today|last\s+(?:week|month|year))\b/gi,
  /\b\d+\s*(?:min|minute)s?\s+read\b/gi,
  new RegExp(`\\b\\d[\\d.,]*\\s*[km]?\\s+${COUNTED}\\b`, "gi"),
  new RegExp(`\\b${COUNTED}\\s*:?\\s*\\d[\\d.,]*\\s*[km]?\\b`, "gi"),
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]m)?\b/gi,
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?(?:\\s+\\d{4})?\\b`, "gi"),
  new RegExp(`\\b\\d{1,2}\\s+${MONTH}(?:\\s+\\d{4})?\\b`, "gi"),
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /©\s*\d{4}(?:\s*[-–]\s*\d{4})?/g,
  // Bare "3h" / "5d" style ages, last so "3 hours ago" is taken whole above.
  /\b\d+\s*[smhdw]\b/gi,
];

// Word diffing is quadratic in how much of a paragraph changed. Past these
// bounds a rewritten paragraph is shown as removed + added instead, which
// keeps a revisit from ever stalling the browser.
const WORD_DIFF_MAX_CHARS = 5000;
const WORD_DIFF_TIMEOUT_MS = 30;
const PARAGRAPH_DIFF_TIMEOUT_MS = 250;
/** Above this share of paragraphs touched, with too little history to tell
 *  a feed from a rewrite, assume it's a feed and stay quiet. */
const FEED_RATIO = 0.6;

export function paragraphs(body: string): string[] {
  return body.split("\n").map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function comparisonKey(paragraph: string): string {
  return VOLATILE.reduce((text, pattern) => text.replace(pattern, "#"), paragraph.toLowerCase());
}

function wordParts(before: string, after: string): WordPart[] | null {
  const longer = Math.max(before.length, after.length);
  const shorter = Math.min(before.length, after.length);
  if (longer > WORD_DIFF_MAX_CHARS || longer > 2.5 * Math.max(shorter, 1)) return null;
  const parts = diffWordsWithSpace(before, after, { timeout: WORD_DIFF_TIMEOUT_MS });
  if (!parts) return null;
  return parts.map((part) => ({
    text: part.value,
    kind: part.added ? "added" : part.removed ? "removed" : "same",
  }));
}

/** Share of characters two paragraphs keep in common, 0..1. */
function similarity(words: WordPart[], before: string, after: string): number {
  const same = words.filter((w) => w.kind === "same").reduce((n, w) => n + w.text.trim().length, 0);
  return same / Math.max(before.length, after.length, 1);
}

export function diffCopies(oldBody: string, newBody: string): DiffResult {
  const before = paragraphs(oldBody);
  const after = paragraphs(newBody);
  const changes = diffArrays(before.map(comparisonKey), after.map(comparisonKey), { timeout: PARAGRAPH_DIFF_TIMEOUT_MS })
    // Gave up: everything before went, everything after arrived.
    ?? [{ value: before, count: before.length, added: false, removed: true }, { value: after, count: after.length, added: true, removed: false }];
  const passages: Passage[] = [];
  let added = 0, removed = 0, edited = 0;
  let i = 0, j = 0;
  for (let c = 0; c < changes.length; c++) {
    const change = changes[c];
    if (!change.added && !change.removed) {
      for (let k = 0; k < change.count; k++) passages.push({ kind: "context", text: after[j + k] });
      i += change.count;
      j += change.count;
      continue;
    }
    // Gather the whole run of removals/additions so a paragraph that was
    // rewritten can be shown as one edit rather than a delete and an add.
    const olds: string[] = [];
    const news: string[] = [];
    while (c < changes.length && (changes[c].added || changes[c].removed)) {
      const run = changes[c];
      if (run.removed) { olds.push(...before.slice(i, i + run.count)); i += run.count; }
      else { news.push(...after.slice(j, j + run.count)); j += run.count; }
      c++;
    }
    c--;
    const paired = Math.min(olds.length, news.length);
    for (let k = 0; k < paired; k++) {
      const words = wordParts(olds[k], news[k]);
      if (words && similarity(words, olds[k], news[k]) >= 0.4) {
        passages.push({ kind: "edited", text: news[k], words });
        edited++;
      } else {
        passages.push({ kind: "removed", text: olds[k] }, { kind: "added", text: news[k] });
        removed++;
        added++;
      }
    }
    for (const text of olds.slice(paired)) { passages.push({ kind: "removed", text }); removed++; }
    for (const text of news.slice(paired)) { passages.push({ kind: "added", text }); added++; }
  }
  const larger = Math.max(before.length, after.length, 1);
  return { passages, added, removed, edited, changedRatio: Math.min(1, (added + removed + edited) / larger) };
}

/** Changed passages with `context` unchanged paragraphs either side; the
 *  rest collapse into counted gaps. */
export function hunks(passages: Passage[], context = 1): Hunk[] {
  const near = (i: number) => {
    for (let k = Math.max(0, i - context); k <= Math.min(passages.length - 1, i + context); k++) {
      if (passages[k].kind !== "context") return true;
    }
    return false;
  };
  const out: Hunk[] = [];
  let gap = 0;
  passages.forEach((passage, i) => {
    if (!near(i)) { gap++; return; }
    if (gap) out.push({ kind: "gap", count: gap });
    gap = 0;
    out.push(passage);
  });
  if (gap) out.push({ kind: "gap", count: gap });
  return out;
}

export function isMeaningful(result: DiffResult, oldBody: string, newBody: string): boolean {
  const a = oldBody.trim().length;
  const b = newBody.trim().length;
  // Lazy pages captured before they finished loading look like mass deletions.
  if (!a || !b || Math.min(a, b) < 0.3 * Math.max(a, b)) return false;
  return result.added + result.removed + result.edited > 0;
}

export function isVolatile(ratios: number[]): boolean {
  return ratios.length >= 3 && ratios.slice(0, 3).every((r) => r > 0.5);
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

export function shortDate(at: number, now: number): string {
  const a = new Date(at);
  const b = new Date(now);
  if (a.toDateString() === b.toDateString()) return "today";
  return a.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(a.getFullYear() === b.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** `copies` are up to three earlier saved copies of `url`, newest first. */
export function decide(input: { url: string; body: string; capturedAt: number; copies: StoredCopy[]; muted: string[] }): Decision {
  const { url, body, capturedAt, copies, muted } = input;
  const host = hostOf(url);
  if (!host || muted.includes(host)) return { action: "clear" };
  const baseline = copies[0];
  if (!baseline) return { action: "clear" };
  if (capturedAt - baseline.capturedAt < BASELINE_MIN_AGE) return { action: "keep" };
  const result = diffCopies(baseline.body, body);
  if (!isMeaningful(result, baseline.body, body)) return { action: "clear" };
  if (copies.length < 3 && result.changedRatio > FEED_RATIO) return { action: "clear" };
  const ratios = [result.changedRatio];
  for (let k = 0; k + 1 < copies.length; k++) ratios.push(diffCopies(copies[k + 1].body, copies[k].body).changedRatio);
  if (isVolatile(ratios)) return { action: "clear" };
  return {
    action: "set",
    change: {
      url,
      capturedAt,
      baselineId: baseline.id,
      baselineAt: baseline.capturedAt,
      currentBody: body,
      summary: { added: result.added, removed: result.removed, edited: result.edited },
    },
  };
}
