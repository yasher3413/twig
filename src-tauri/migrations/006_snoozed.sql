CREATE TABLE snoozed (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  space_id TEXT,
  space_name TEXT,
  wake_at INTEGER NOT NULL,
  snoozed_at INTEGER NOT NULL
);
CREATE INDEX idx_snoozed_wake ON snoozed(wake_at);
