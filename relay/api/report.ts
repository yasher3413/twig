// POST /api/report - files a bug report from twig as a GitHub issue.
// The GitHub token lives only here (GITHUB_TOKEN), never in the app, which
// anyone could take apart. It can touch nothing but this repo's issues.
import { createLimiter, issueFor, parseReport } from "../lib/report.js";

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
  const token = process.env.GITHUB_TOKEN;
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

  const repo = process.env.GITHUB_REPO ?? "yasher3413/twig";
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "twig-bug-relay",
    },
    body: JSON.stringify(issueFor(parsed.report)),
  });
  if (!res.ok) {
    console.error("GitHub refused the report", res.status, await res.text());
    return reply(502, { error: "GitHub didn't accept the report." });
  }
  const issue = (await res.json()) as { number: number; html_url: string };
  return reply(201, { number: issue.number, url: issue.html_url });
}
