import Database from "@tauri-apps/plugin-sql";

const db = Database.get("sqlite:twig.db");
const MAX_COPIES = 2000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

export interface RecallCapture {
  url: string;
  title: string;
  body: string;
  capturedAt: number;
  spaceId: string | null;
  spaceName: string | null;
  sessionId: string | null;
}

export interface RecallMatch extends Omit<RecallCapture, "body"> {
  id: number;
  snippet: string;
}

export interface RecallCopy extends RecallMatch { body: string }

export interface RecallFilters {
  query: string;
  spaceId?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

const columns = `c.id, c.url, c.title, c.captured_at AS capturedAt,
  c.space_id AS spaceId, c.space_name AS spaceName, c.session_id AS sessionId`;
let writes: Promise<void> = Promise.resolve();
let clearedThrough = -1;
const forgottenThrough = new Map<string, number>();

// All capture/deletion operations share one queue. A failed write must not
// poison the next operation. Cutoffs also reject delayed native extractions.
function write(action: () => Promise<void>): Promise<void> {
  const result = writes.then(action);
  writes = result.catch(() => {});
  return result;
}

function changed() {
  window.dispatchEvent(new Event("twig:recall-changed"));
}

function bounded(value: number | undefined, fallback: number, max: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(max, Math.floor(value)));
}

function validate(capture: RecallCapture): RecallCapture {
  if (typeof capture.url !== "string" || /[\u0000-\u0020\u007f]/.test(capture.url)) {
    throw new Error("Only public HTTP or HTTPS page addresses can be saved.");
  }
  let url: URL;
  try { url = new URL(capture.url); } catch { throw new Error("The page address is invalid."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Only HTTP or HTTPS addresses without credentials can be saved.");
  }
  if (!Number.isSafeInteger(capture.capturedAt) || capture.capturedAt < 0 || capture.capturedAt > Date.now() + 60_000) {
    throw new Error("The reading copy has an invalid capture time.");
  }
  if (typeof capture.body !== "string" || typeof capture.title !== "string") {
    throw new Error("The reading copy is missing its page text.");
  }
  return {
    ...capture,
    title: capture.title.slice(0, 2000),
    body: capture.body.slice(0, 40_000),
    spaceId: capture.spaceId || null,
    spaceName: capture.spaceName?.slice(0, 256) || null,
    sessionId: capture.sessionId || null,
  };
}

export async function indexRecall(input: RecallCapture): Promise<void> {
  const capture = validate(input);
  if (!capture.body.trim()) return;
  return write(async () => {
    if (capture.capturedAt <= Math.max(clearedThrough, forgottenThrough.get(capture.url) ?? -1)) return;
    const duplicate = await db.select<{ id: number }[]>(
      `SELECT id FROM recall_captures WHERE url = $1 AND space_id IS $2
       AND title = $3 AND body = $4 AND captured_at BETWEEN $5 AND $6 LIMIT 1`,
      [capture.url, capture.spaceId, capture.title, capture.body,
        capture.capturedAt - FIFTEEN_MINUTES, capture.capturedAt + FIFTEEN_MINUTES],
    );
    if (duplicate.length) return;
    const [count] = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM recall_captures");
    if (count.n >= MAX_COPIES) {
      throw new Error("Recall has reached 2,000 saved copies. Forget some copies to resume saving; your existing copies are kept.");
    }
    await db.execute(
      `INSERT INTO recall_captures (url, title, body, captured_at, space_id, space_name, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [capture.url, capture.title, capture.body, capture.capturedAt, capture.spaceId, capture.spaceName, capture.sessionId],
    );
    changed();
  });
}

export async function searchRecall(filters: RecallFilters): Promise<RecallMatch[]> {
  await writes;
  const query = filters.query.trim();
  // Only literal words reach MATCH. Quotes, parentheses and FTS operators
  // remain search text rather than executable FTS syntax.
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (query && terms.length === 0) return [];
  const values: (string | number)[] = [];
  const conditions: string[] = [];
  const bind = (value: string | number) => { values.push(value); return `$${values.length}`; };
  if (query) conditions.push(`recall_fts MATCH ${bind(terms.slice(0, 64).map((term) => `"${term}"`).join(" "))}`);
  if (filters.spaceId === "__unknown__") conditions.push("c.space_id IS NULL");
  else if (filters.spaceId !== undefined) conditions.push(`c.space_id = ${bind(filters.spaceId)}`);
  if (filters.from !== undefined) {
    if (!Number.isSafeInteger(filters.from)) throw new Error("The start date is invalid.");
    conditions.push(`c.captured_at >= ${bind(filters.from)}`);
  }
  if (filters.to !== undefined) {
    if (!Number.isSafeInteger(filters.to)) throw new Error("The end date is invalid.");
    conditions.push(`c.captured_at < ${bind(filters.to)}`);
  }
  const snippet = query ? "snippet(recall_fts, 1, '[[', ']]', '…', 32)" : "substr(c.body, 1, 240)";
  return db.select<RecallMatch[]>(
    `SELECT ${columns}, ${snippet} AS snippet FROM recall_captures c
     ${query ? "JOIN recall_fts ON recall_fts.rowid = c.id" : ""}
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY ${query ? "rank, " : ""}c.captured_at DESC, c.id DESC
     LIMIT ${bind(bounded(filters.limit, 50, MAX_COPIES))} OFFSET ${bind(bounded(filters.offset, 0, Number.MAX_SAFE_INTEGER))}`,
    values,
  );
}

export async function getRecallCopy(id: number): Promise<RecallCopy | null> {
  await writes;
  const rows = await db.select<RecallCopy[]>(
    `SELECT ${columns}, c.body, substr(c.body, 1, 240) AS snippet FROM recall_captures c WHERE c.id = $1`, [id],
  );
  return rows[0] ?? null;
}

export async function recallSpaces(): Promise<{ id: string; name: string }[]> {
  await writes;
  return db.select<{ id: string; name: string }[]>(
    `SELECT COALESCE(space_id, '__unknown__') AS id,
       COALESCE(space_name, CASE WHEN space_id IS NULL THEN 'Unknown space' ELSE space_id END) AS name
     FROM (SELECT space_id, space_name, ROW_NUMBER() OVER (PARTITION BY space_id ORDER BY captured_at DESC, id DESC) AS n
       FROM recall_captures) WHERE n = 1 ORDER BY name COLLATE NOCASE`,
  );
}

export async function recallCount(): Promise<number> {
  await writes;
  const rows = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM recall_captures");
  return rows[0]?.n ?? 0;
}

export async function nearbyRecall(id: number): Promise<RecallMatch[]> {
  const copy = await getRecallCopy(id);
  // Legacy unknown sessions cannot establish a browsing relationship.
  if (!copy?.sessionId) return [];
  return db.select<RecallMatch[]>(
    `SELECT ${columns}, substr(c.body, 1, 240) AS snippet FROM recall_captures c
     WHERE c.session_id = $1 AND c.space_id IS $2 AND c.url != $3
       AND c.captured_at BETWEEN $4 AND $5
     ORDER BY c.captured_at, c.id LIMIT 8`,
    [copy.sessionId, copy.spaceId, copy.url, copy.capturedAt - 30 * 60_000, copy.capturedAt + 30 * 60_000],
  );
}

export async function deleteRecallCopy(id: number): Promise<void> {
  const cutoff = Date.now();
  return write(async () => {
    const rows = await db.select<{ url: string }[]>("SELECT url FROM recall_captures WHERE id = $1", [id]);
    if (rows[0]) forgottenThrough.set(rows[0].url, Math.max(cutoff, forgottenThrough.get(rows[0].url) ?? -1));
    await db.execute("DELETE FROM recall_captures WHERE id = $1", [id]);
    changed();
  });
}

function forget(url: string | undefined, history: boolean): Promise<void> {
  const cutoff = Date.now();
  if (url !== undefined) forgottenThrough.set(url, Math.max(cutoff, forgottenThrough.get(url) ?? -1));
  else { clearedThrough = Math.max(cutoff, clearedThrough); forgottenThrough.clear(); }
  return write(async () => {
    const where = url === undefined ? "" : " WHERE url = $1";
    const values = url === undefined ? [] : [url];
    // Delete recall first: if history deletion fails, indexed private text
    // has still been forgotten. Cutoffs remain active on errors for safety.
    await db.execute(`DELETE FROM recall_captures${where}`, values);
    if (history) await db.execute(`DELETE FROM history${where}`, values);
    changed();
  });
}

export function deleteRecallUrl(url: string): Promise<void> { return forget(url, false); }
export function clearRecall(): Promise<void> { return forget(undefined, false); }
export function forgetRecallHistory(url?: string): Promise<void> { return forget(url, true); }
