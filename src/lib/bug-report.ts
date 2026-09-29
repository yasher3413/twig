import { issueFor, parseReport, type Report } from "../../relay/lib/report";

/** The relay that turns a report into a GitHub issue (see relay/). */
export const REPORT_ENDPOINT = "https://twig-bug-reports.vercel.app/api/report";
const NEW_ISSUE = "https://github.com/yasher3413/twig/issues/new";

export interface Setup { version: string; macos: string; chip: string }
export interface ReportFields { happened: string; expected: string; contact: string; includeSetup: boolean }
export type ReportPayload = Report & { website: string };

const orNull = (value: string) => value.trim() || null;

/** What gets sent: your words, and twig/macOS/chip only if you allow it.
 *  Never the page you're on or your history. */
export function buildReport(fields: ReportFields, setup: Setup): ReportPayload {
  return {
    happened: fields.happened.trim(),
    expected: orNull(fields.expected),
    contact: orNull(fields.contact),
    diagnostics: fields.includeSetup ? setup : null,
    // The relay's bot trap; people never fill it.
    website: "",
  };
}

/** A new-issue page with the report already written, for when the relay
 *  can't be reached. Same wording as a relayed report. */
export function fallbackIssueUrl(payload: ReportPayload): string {
  const parsed = parseReport(payload);
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
