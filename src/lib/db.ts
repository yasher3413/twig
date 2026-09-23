import Database from "@tauri-apps/plugin-sql";
import { isInternalUrl } from "./tabs";
import { clearRecall, forgetRecallHistory, indexRecall, searchRecall } from "./recall-db";
import type { RecallCapture } from "./recall-db";

// Connection is established lazily on first query; must match the db_url
// passed to add_migrations in src-tauri/src/lib.rs.
const db = Database.get("sqlite:twig.db");

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  visitedAt: number;
}

export interface Bookmark {
  id: number;
  url: string;
  title: string;
}

interface HistoryRow {
  id: number;
  url: string;
  title: string;
  visited_at: number;
}

interface BookmarkRow {
  id: number;
  url: string;
  title: string;
}

/** Records a page visit. No-ops for the blank new-tab page. */
export async function recordVisit(url: string, title: string): Promise<void> {
  if (!url || isInternalUrl(url)) return;
  await db.execute("INSERT INTO history (url, title, visited_at) VALUES ($1, $2, $3)", [
    url,
    title,
    Date.now(),
  ]);
}

/** Most recently visited pages matching `query`, one row per URL. */
export async function searchHistory(query: string, limit = 5): Promise<HistoryEntry[]> {
  const like = `%${query}%`;
  const rows = await db.select<HistoryRow[]>(
    `SELECT id, url, title, MAX(visited_at) as visited_at FROM history
     WHERE url LIKE $1 OR title LIKE $1
     GROUP BY url
     ORDER BY visited_at DESC
     LIMIT $2`,
    [like, limit],
  );
  return rows.map((r) => ({ id: r.id, url: r.url, title: r.title, visitedAt: r.visited_at }));
}

/** Most-visited pages, for the new tab page. Ranked by visit count so the
 *  grid stays stable instead of reshuffling after every single page view. */
export async function topSites(limit = 8): Promise<HistoryEntry[]> {
  const rows = await db.select<HistoryRow[]>(
    `SELECT MIN(id) as id, url, title, MAX(visited_at) as visited_at FROM history
     GROUP BY url
     ORDER BY COUNT(*) DESC, MAX(visited_at) DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ id: r.id, url: r.url, title: r.title, visitedAt: r.visited_at }));
}

/** Total distinct pages recorded - shown on the new tab page so it's
 *  obvious that history exists and is local. */
export async function historyCount(): Promise<number> {
  const rows = await db.select<{ n: number }[]>(
    "SELECT COUNT(DISTINCT url) as n FROM history",
  );
  return rows[0]?.n ?? 0;
}

/** History ranked for omnibox autocomplete: prefix matches on the host
 *  first (typing "git" should reach github before a page that merely
 *  mentions it), then by how often the page has been visited. */
export async function autocomplete(query: string, limit = 6): Promise<HistoryEntry[]> {
  if (!query.trim()) return [];
  const like = `%${query}%`;
  const prefix = `${query}%`;
  const rows = await db.select<HistoryRow[]>(
    `SELECT MIN(id) as id, url, title, MAX(visited_at) as visited_at FROM history
     WHERE url LIKE $1 OR title LIKE $1
     GROUP BY url
     ORDER BY
       CASE
         WHEN url LIKE 'https://' || $2 THEN 0
         WHEN url LIKE 'https://www.' || $2 THEN 0
         WHEN title LIKE $2 THEN 1
         ELSE 2
       END,
       COUNT(*) DESC,
       MAX(visited_at) DESC
     LIMIT $3`,
    [like, prefix, limit],
  );
  return rows.map((r) => ({ id: r.id, url: r.url, title: r.title, visitedAt: r.visited_at }));
}

export interface PageMatch {
  url: string;
  title: string;
  snippet: string;
}

/** Keeps an immutable reading copy together with its original context. */
export function indexPage(capture: RecallCapture): Promise<void> {
  return indexRecall(capture);
}

/** Searches the text of pages you've actually read, not just their titles.
 *  `snippet` comes back with the matched terms wrapped in [[ ]] so the UI
 *  can highlight them without re-finding the match. */
export async function searchPages(query: string, limit = 8): Promise<PageMatch[]> {
  const q = query.trim();
  if (!q) return [];
  const rows = await searchRecall({ query: q, limit: 2000 });
  const pages = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const previous = pages.get(row.url);
    if (!previous || previous.capturedAt < row.capturedAt) pages.set(row.url, row);
  }
  return Array.from(pages.values()).slice(0, Math.max(0, limit));
}

export function clearPageIndex(): Promise<void> {
  return clearRecall();
}

/** Forgets every visit to a URL, and its indexed text with it. */
export function deleteHistoryUrl(url: string): Promise<void> {
  return forgetRecallHistory(url);
}

/** Wipes local browsing history. Bookmarks are kept - they're explicit. */
export function clearHistory(): Promise<void> {
  return forgetRecallHistory();
}

export interface ArchivedTab {
  id: number;
  url: string;
  title: string;
  closedAt: number;
}

/** Keeps a closed tab so it can be found again later. The reopen stack
 *  only holds the last 20 and dies with the process; this doesn't. */
export async function archiveTab(url: string, title: string): Promise<void> {
  if (!url || isInternalUrl(url)) return;
  await db.execute("DELETE FROM archive WHERE url = $1", [url]);
  await db.execute("INSERT INTO archive (url, title, closed_at) VALUES ($1, $2, $3)", [
    url,
    title,
    Date.now(),
  ]);
}

export async function searchArchive(query: string, limit = 300): Promise<ArchivedTab[]> {
  const like = `%${query}%`;
  const rows = await db.select<{ id: number; url: string; title: string; closed_at: number }[]>(
    `SELECT id, url, title, closed_at FROM archive
     WHERE url LIKE $1 OR title LIKE $1
     ORDER BY closed_at DESC
     LIMIT $2`,
    [like, limit],
  );
  return rows.map((r) => ({ id: r.id, url: r.url, title: r.title, closedAt: r.closed_at }));
}

export async function deleteArchiveUrl(url: string): Promise<void> {
  await db.execute("DELETE FROM archive WHERE url = $1", [url]);
}

export async function addBookmark(url: string, title: string): Promise<void> {
  await db.execute(
    "INSERT INTO bookmarks (url, title, created_at) VALUES ($1, $2, $3) ON CONFLICT(url) DO NOTHING",
    [url, title, Date.now()],
  );
}

export async function removeBookmark(url: string): Promise<void> {
  await db.execute("DELETE FROM bookmarks WHERE url = $1", [url]);
}

export async function isBookmarked(url: string): Promise<boolean> {
  const rows = await db.select<unknown[]>("SELECT 1 FROM bookmarks WHERE url = $1 LIMIT 1", [
    url,
  ]);
  return rows.length > 0;
}

export async function searchBookmarks(query: string, limit = 5): Promise<Bookmark[]> {
  const like = `%${query}%`;
  const rows = await db.select<BookmarkRow[]>(
    `SELECT id, url, title FROM bookmarks
     WHERE url LIKE $1 OR title LIKE $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [like, limit],
  );
  return rows.map((r) => ({ id: r.id, url: r.url, title: r.title }));
}
