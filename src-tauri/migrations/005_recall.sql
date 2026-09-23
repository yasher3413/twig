CREATE TABLE recall_captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    space_id TEXT,
    space_name TEXT,
    session_id TEXT
);
CREATE INDEX idx_recall_time ON recall_captures(captured_at DESC);
CREATE INDEX idx_recall_url_space ON recall_captures(url, space_id, captured_at);
CREATE INDEX idx_recall_context ON recall_captures(space_id, session_id, captured_at);

CREATE VIRTUAL TABLE recall_fts USING fts5(
    title, body,
    content = 'recall_captures', content_rowid = 'id',
    tokenize = 'porter unicode61'
);
CREATE TRIGGER recall_insert AFTER INSERT ON recall_captures BEGIN
    INSERT INTO recall_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER recall_delete AFTER DELETE ON recall_captures BEGIN
    INSERT INTO recall_fts(recall_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER recall_update AFTER UPDATE ON recall_captures BEGIN
    INSERT INTO recall_fts(recall_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
    INSERT INTO recall_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

-- Preserve every legacy copy, including collections over the new capture cap.
-- The former index did not record spaces or sessions; leave those unknown.
INSERT INTO recall_captures(url, title, body, captured_at)
SELECT url, COALESCE(title, ''), COALESCE(body, ''), CAST(captured_at AS INTEGER)
FROM page_text;
DROP TABLE page_text;
