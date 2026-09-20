import Database from "@tauri-apps/plugin-sql";

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
  if (!url || url === "about:blank") return;
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
