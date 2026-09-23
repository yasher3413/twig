import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "./tabs";

export interface TextPart { text: string; matched: boolean }

export function snippetParts(snippet: string): TextPart[] {
  const parts: TextPart[] = [];
  const pattern = /\[\[([\s\S]*?)\]\]/g;
  let cursor = 0;
  for (const match of snippet.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ text: snippet.slice(cursor, start), matched: false });
    parts.push({ text: match[1], matched: true });
    cursor = start + match[0].length;
  }
  if (cursor < snippet.length) parts.push({ text: snippet.slice(cursor), matched: false });
  return parts;
}

export function passageFromSnippet(snippet: string): string {
  const sections = snippet.split("…");
  const matched = sections.filter((section) => section.includes("[["));
  const section = (matched.length ? matched : sections).sort((a, b) => b.length - a.length)[0] ?? "";
  return snippetParts(section).map((part) => part.text).join("").replace(/\s+/g, " ").trim().slice(0, 2000);
}

export function readingParts(body: string, query: string): TextPart[] {
  const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 64);
  if (!terms.length) return [{ text: body, matched: false }];
  const escaped = terms.sort((a, b) => b.length - a.length).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(escaped.join("|"), "gi");
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ text: body.slice(cursor, start), matched: false });
    parts.push({ text: match[0], matched: true });
    cursor = start + match[0].length;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor), matched: false });
  return parts;
}

export function localDayBounds(from: string, through: string): { from?: number; to?: number } {
  function parse(day: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Choose a valid calendar date.");
    const [year, month, date] = day.split("-").map(Number);
    const result = new Date(0);
    result.setFullYear(year, month - 1, date);
    result.setHours(0, 0, 0, 0);
    if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== date) {
      throw new Error("Choose a valid calendar date.");
    }
    return result;
  }
  const start = from ? parse(from) : null;
  const end = through ? parse(through) : null;
  if (start && end && start > end) throw new Error("The start date must be on or before the end date.");
  if (end) end.setDate(end.getDate() + 1);
  return { from: start?.getTime(), to: end?.getTime() };
}

export function dateInputValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function openRecall(query = ""): void {
  window.dispatchEvent(new CustomEvent("twig:recall", { detail: { query } }));
}

export function openRecalledPage(url: string, passage: string): Promise<Tab> {
  return invoke("open_recalled_page", { url, passage });
}
