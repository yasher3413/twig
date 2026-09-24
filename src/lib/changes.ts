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
const VOLATILE: RegExp[] = [
  /\b\d+\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|months?|y|yrs?|years?)\s+ago\b/gi,
  /\b(?:just now|yesterday|today)\b/gi,
  /\b\d+(?:[.,]\d+)?\s*[km]?\s+(?:views?|comments?|likes?|replies|reply|points?|stars?|shares?|reactions?|upvotes?|followers?|reads?)\b/gi,
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]m)?\b/gi,
];

export function paragraphs(body: string): string[] {
  return body.split("\n").map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function comparisonKey(paragraph: string): string {
  return VOLATILE.reduce((text, pattern) => text.replace(pattern, "#"), paragraph.toLowerCase());
}

function wordParts(before: string, after: string): WordPart[] {
  return diffWordsWithSpace(before, after).map((part) => ({
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
  const changes = diffArrays(before.map(comparisonKey), after.map(comparisonKey));
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
      if (similarity(words, olds[k], news[k]) >= 0.4) {
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
