// What the relay accepts from twig's "Report a bug" form, and how it turns
// into a GitHub issue. Pure, so it can be tested without a network.

export interface Report {
  happened: string;
  expected: string | null;
  contact: string | null;
  diagnostics: { version: string; macos: string; chip: string } | null;
}

export interface Screenshot { bytes: Uint8Array; type: string; ext: string }

const MAX_TEXT = 5000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

// The first bytes of each allowed format. The claimed type has to match
// what the file actually is, so nothing but a real image gets stored.
const IMAGE_TYPES: Record<string, { ext: string; magic: number[] }> = {
  "image/png": { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  "image/jpeg": { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/webp": { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
};

export function parseScreenshot(input: unknown): ({ ok: true } & Screenshot) | { ok: false; error: string } {
  const shot = input as { type?: unknown; data?: unknown } | null;
  const format = typeof shot?.type === "string" ? IMAGE_TYPES[shot.type] : undefined;
  if (!format || typeof shot?.data !== "string") return { ok: false, error: "Screenshots must be PNG, JPEG or WebP." };
  if (shot.data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) return { ok: false, error: "The screenshot is too large (3 MB at most)." };
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
  } catch {
    return { ok: false, error: "The screenshot couldn't be read." };
  }
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: "The screenshot is too large (3 MB at most)." };
  if (!format.magic.every((b, i) => bytes[i] === b)) return { ok: false, error: "The screenshot isn't a valid image." };
  return { ok: true, bytes, type: shot.type as string, ext: format.ext };
}

const MAX_SHORT = 200;

function text(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length > max) return undefined;
  return trimmed || null;
}

export function parseReport(input: unknown):
  { ok: true; report: Report; screenshot: Screenshot | null } | { ok: false; error: string } {
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
  let screenshot: Screenshot | null = null;
  if (body.screenshot !== undefined && body.screenshot !== null) {
    const parsed = parseScreenshot(body.screenshot);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    screenshot = { bytes: parsed.bytes, type: parsed.type, ext: parsed.ext };
  }
  return { ok: true, report: { happened, expected, contact, diagnostics }, screenshot };
}

export function issueFor(report: Report, screenshotUrl?: string): { title: string; body: string; labels: string[] } {
  const first = report.happened.split("\n")[0].trim();
  const title = first.length > 80 ? `${first.slice(0, 79)}…` : first;
  const parts = [`### What happened\n\n${report.happened}`];
  if (report.expected) parts.push(`### What I expected\n\n${report.expected}`);
  if (report.diagnostics) {
    const { version, macos, chip } = report.diagnostics;
    parts.push(`### Setup\n\ntwig ${version} · macOS ${macos} · ${chip}`);
  }
  if (screenshotUrl) parts.push(`### Screenshot\n\n![Screenshot](${screenshotUrl})`);
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
