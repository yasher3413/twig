// What the relay accepts from twig's "Report a bug" form, and how it turns
// into a GitHub issue. Pure, so it can be tested without a network.

export interface Report {
  happened: string;
  expected: string | null;
  contact: string | null;
  diagnostics: { version: string; macos: string; chip: string } | null;
}

const MAX_TEXT = 5000;
const MAX_SHORT = 200;

function text(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length > max) return undefined;
  return trimmed || null;
}

export function parseReport(input: unknown): { ok: true; report: Report } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "The report is empty." };
  const body = input as Record<string, unknown>;
  // A field people never see: only bots fill it in.
  if (typeof body.website === "string" && body.website.trim()) return { ok: false, error: "Rejected." };
  const happened = text(body.happened, MAX_TEXT);
  if (!happened) return { ok: false, error: "Say what happened (up to 5,000 characters)." };
  const expected = text(body.expected, MAX_TEXT);
  const contact = text(body.contact, MAX_SHORT);
  if (expected === undefined || contact === undefined) return { ok: false, error: "Part of the report is too long." };
  let diagnostics: Report["diagnostics"] = null;
  const d = body.diagnostics as Record<string, unknown> | undefined;
  if (d && typeof d === "object") {
    const version = text(d.version, 40), macos = text(d.macos, 40), chip = text(d.chip, 40);
    if (version && macos && chip) diagnostics = { version, macos, chip };
  }
  return { ok: true, report: { happened, expected, contact, diagnostics } };
}

export function issueFor(report: Report): { title: string; body: string; labels: string[] } {
  const first = report.happened.split("\n")[0].trim();
  const title = first.length > 80 ? `${first.slice(0, 79)}…` : first;
  const parts = [`### What happened\n\n${report.happened}`];
  if (report.expected) parts.push(`### What I expected\n\n${report.expected}`);
  if (report.diagnostics) {
    const { version, macos, chip } = report.diagnostics;
    parts.push(`### Setup\n\ntwig ${version} · macOS ${macos} · ${chip}`);
  }
  if (report.contact) parts.push(`Contact: ${report.contact}`);
  parts.push("_Sent from twig's Report a Bug form._");
  return { title, body: parts.join("\n\n"), labels: ["bug", "from-twig"] };
}

/** At most `max` reports per sender per `windowMs`. Best effort: it lives in
 *  one function instance's memory, which is enough to blunt a script. */
export function createLimiter(max: number, windowMs: number) {
  const seen = new Map<string, number[]>();
  return (sender: string, now: number): boolean => {
    const recent = (seen.get(sender) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      seen.set(sender, recent);
      return false;
    }
    recent.push(now);
    seen.set(sender, recent);
    return true;
  };
}
