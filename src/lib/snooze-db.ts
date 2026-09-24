import Database from "@tauri-apps/plugin-sql";

const db = Database.get("sqlite:twig.db");

export interface SnoozedTab {
  id: number;
  url: string;
  title: string;
  spaceId: string | null;
  spaceName: string | null;
  wakeAt: number;
  snoozedAt: number;
}

const columns = `id, url, title, space_id AS spaceId, space_name AS spaceName,
  wake_at AS wakeAt, snoozed_at AS snoozedAt`;

export async function addSnooze(input: { url: string; title: string; spaceId: string | null; spaceName: string | null; wakeAt: number }): Promise<void> {
  await db.execute(
    `INSERT INTO snoozed (url, title, space_id, space_name, wake_at, snoozed_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.url, input.title, input.spaceId, input.spaceName, input.wakeAt, Date.now()],
  );
}

export function dueSnoozes(now: number): Promise<SnoozedTab[]> {
  return db.select<SnoozedTab[]>(`SELECT ${columns} FROM snoozed WHERE wake_at <= $1 ORDER BY wake_at, id`, [now]);
}

export function listSnoozes(): Promise<SnoozedTab[]> {
  return db.select<SnoozedTab[]>(`SELECT ${columns} FROM snoozed ORDER BY wake_at, id`);
}

export async function nextWakeAt(): Promise<number | null> {
  const rows = await db.select<{ n: number | null }[]>("SELECT MIN(wake_at) AS n FROM snoozed");
  return rows[0]?.n ?? null;
}

export async function deleteSnooze(id: number): Promise<void> {
  await db.execute("DELETE FROM snoozed WHERE id = $1", [id]);
}
