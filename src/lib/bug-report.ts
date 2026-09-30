import { issueFor, parseReport, type Report } from "../../relay/lib/report";

/** The relay that turns a report into a GitHub issue (see relay/). */
export const REPORT_ENDPOINT = "https://twig-bug-reports.vercel.app/api/report";
const NEW_ISSUE = "https://github.com/yasher3413/twig/issues/new";

export interface Setup { version: string; macos: string; chip: string }
export interface ReportFields { happened: string; expected: string; contact: string; includeSetup: boolean }
export interface ScreenshotData { type: string; data: string }
export type ReportPayload = Report & { website: string; screenshot: ScreenshotData | null };

/** Largest edge a screenshot is sent at. Big enough to read UI text, small
 *  enough to stay well under the relay's request limit. */
export const SCREENSHOT_MAX_EDGE = 2000;
const SCREENSHOT_MAX_BYTES = 2.5 * 1024 * 1024;

const orNull = (value: string) => value.trim() || null;

/** What gets sent: your words, and twig/macOS/chip only if you allow it.
 *  Never the page you're on or your history. */
export function buildReport(fields: ReportFields, setup: Setup, screenshot: ScreenshotData | null = null): ReportPayload {
  return {
    happened: fields.happened.trim(),
    expected: orNull(fields.expected),
    contact: orNull(fields.contact),
    diagnostics: fields.includeSetup ? setup : null,
    // The relay's bot trap; people never fill it.
    website: "",
    screenshot,
  };
}

/** A new-issue page with the report already written, for when the relay
 *  can't be reached. Same wording as a relayed report. */
export function fallbackIssueUrl(payload: ReportPayload): string {
  // A web link can't carry an image; the form tells people to drag it in.
  const parsed = parseReport({ ...payload, screenshot: null });
  const report: Report = parsed.ok ? parsed.report : { happened: payload.happened, expected: null, contact: null, diagnostics: null };
  const issue = issueFor(report);
  const params = new URLSearchParams({ title: issue.title, body: issue.body, labels: issue.labels.join(",") });
  return `${NEW_ISSUE}?${params}`;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export async function sendReport(payload: ReportPayload, fetchImpl: Fetch = fetch):
  Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }> {
  let res;
  try {
    res = await fetchImpl(REPORT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, error: "Couldn't reach the report service. Are you online?" };
  }
  const body = (await res.json().catch(() => ({}))) as { number?: number; url?: string; error?: string };
  if (res.ok && typeof body.number === "number" && typeof body.url === "string") {
    return { ok: true, number: body.number, url: body.url };
  }
  return { ok: false, error: body.error ?? `The report service answered ${res.status}.` };
}

export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Shrinks a picked, pasted or dropped image to something the relay will
 *  take: PNG when that's small enough (sharpest for UI), JPEG otherwise. */
export async function prepareScreenshot(file: Blob): Promise<ScreenshotData> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, SCREENSHOT_MAX_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Couldn't read that image.");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  for (const [type, quality] of [["image/png", undefined], ["image/jpeg", 0.85], ["image/jpeg", 0.7]] as const) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    if (blob && blob.size <= SCREENSHOT_MAX_BYTES) {
      return { type, data: toBase64(new Uint8Array(await blob.arrayBuffer())) };
    }
  }
  throw new Error("That image is too large to send, even shrunk.");
}
