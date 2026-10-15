CREATE TABLE IF NOT EXISTS release_tracklists (
  album_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  release_group_id TEXT,
  source TEXT NOT NULL,
  tracklist_json TEXT NOT NULL,
  editions_json TEXT,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);
