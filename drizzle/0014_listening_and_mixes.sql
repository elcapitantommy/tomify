-- Listening history Tomify records itself. Navidrome only keeps a play count and the last time each song played,
-- so mixes need this to know what was played when and what was skipped.
CREATE TABLE IF NOT EXISTS listening_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  track_id TEXT NOT NULL,
  album_id TEXT,
  artist_id TEXT,
  title TEXT,
  artist TEXT,
  album TEXT,
  duration_seconds INTEGER,
  listened_seconds INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  played_at INTEGER NOT NULL,
  device TEXT
);
CREATE INDEX IF NOT EXISTS listening_events_user_time ON listening_events (username, played_at);

-- The "Made for you" mixes built for each account, replaced as a whole on every refresh.
CREATE TABLE IF NOT EXISTS made_for_you (
  username TEXT PRIMARY KEY,
  mixes_json TEXT NOT NULL DEFAULT '[]',
  generated_at INTEGER,
  curated_by TEXT,
  refresh_started_at INTEGER,
  last_error TEXT
);
