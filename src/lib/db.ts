import Database from "@tauri-apps/plugin-sql";
import { isInternalUrl } from "./tabs";

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

/** Records a page's text in the local full-text index, replacing whatever
 *  was there for that URL. */
export async function indexPage(url: string, title: string, body: string): Promise<void> {
  if (!url || isInternalUrl(url)) return;
  await db.execute("DELETE FROM page_text WHERE url = $1", [url]);
  await db.execute(
    "INSERT INTO page_text (url, title, body, captured_at) VALUES ($1, $2, $3, $4)",
    [url, title, body, Date.now()],
  );
}

/** Searches the text of pages you've actually read, not just their titles.
 *  `snippet` comes back with the matched terms wrapped in [[ ]] so the UI
 *  can highlight them without re-finding the match. */
export async function searchPages(query: string, limit = 8): Promise<PageMatch[]> {
  const q = query.trim();
  if (!q) return [];
  // Quoted so FTS5 treats user input as terms rather than operators; a
  // stray quote or AND would otherwise be a syntax error.
  const match = q
    .split(/\s+/)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" ");
  try {
    const rows = await db.select<{ url: string; title: string; snippet: string }[]>(
      `SELECT url, title, snippet(page_text, 2, '[[', ']]', '…', 12) as snippet
       FROM page_text WHERE page_text MATCH $1
       ORDER BY rank
       LIMIT $2`,
      [match, limit],
    );
    return rows;
  } catch {
    // A malformed query shouldn't take the palette down with it.
    return [];
  }
}

export async function clearPageIndex(): Promise<void> {
  await db.execute("DELETE FROM page_text");
}

/** Forgets every visit to a URL, and its indexed text with it. */
export async function deleteHistoryUrl(url: string): Promise<void> {
  await db.execute("DELETE FROM history WHERE url = $1", [url]);
  await db.execute("DELETE FROM page_text WHERE url = $1", [url]);
}

/** Wipes local browsing history. Bookmarks are kept - they're explicit. */
export async function clearHistory(): Promise<void> {
  await db.execute("DELETE FROM history");
  await clearPageIndex();
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
