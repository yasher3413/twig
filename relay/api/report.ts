// POST /api/report - files a bug report from twig as a GitHub issue.
// The GitHub token lives only here (GITHUB_TOKEN), never in the app, which
// anyone could take apart. It can touch nothing but this repo's issues.
import { put } from "@vercel/blob";
import { createLimiter, issueFor, parseReport, type Screenshot } from "../lib/report.js";

const limit = createLimiter(5, 60 * 60 * 1000);

// twig's interface is served from tauri://localhost, so this is a
// cross-origin request; the endpoint is public by nature anyway.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function reply(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: CORS });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(request: Request): Promise<Response> {
  // Pasted secrets often carry a stray newline or space; GitHub rejects those.
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) return reply(503, { error: "Bug reports aren't set up yet." });

  const sender = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!limit(sender, Date.now())) {
    return reply(429, { error: "That's a lot of reports from here. Try again in an hour." });
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return reply(400, { error: "The report couldn't be read." });
  }
  const parsed = parseReport(input);
  if (!parsed.ok) return reply(400, { error: parsed.error });

  // GitHub has no API for attaching images to issues, so a screenshot is
  // stored publicly in Vercel Blob under an unguessable name and linked.
  let screenshotUrl: string | undefined;
  let screenshotLost = false;
  if (parsed.screenshot) {
    try {
      screenshotUrl = await storeScreenshot(parsed.screenshot);
    } catch (cause) {
      console.error("Couldn't store a screenshot", cause);
      screenshotLost = true;
    }
  }
  const issue = issueFor(parsed.report, screenshotUrl);
  if (screenshotLost) issue.body += "\n\n_A screenshot was attached but couldn't be stored._";

  const repo = process.env.GITHUB_REPO ?? "yasher3413/twig";
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "twig-bug-relay",
    },
    body: JSON.stringify(issue),
  });
  if (!res.ok) {
    console.error("GitHub refused the report", res.status, await res.text());
    return reply(502, { error: "GitHub didn't accept the report." });
  }
  const filed = (await res.json()) as { number: number; html_url: string };
  return reply(201, { number: filed.number, url: filed.html_url });
}

async function storeScreenshot(shot: Screenshot): Promise<string> {
  const blob = await put(`screenshots/${crypto.randomUUID()}.${shot.ext}`, Buffer.from(shot.bytes), {
    access: "public",
    contentType: shot.type,
  });
  return blob.url;
}
