-- Lyrics looked up on LRCLIB, saved so each song is only looked up once for every device. A row with no lyrics
-- records a miss; the Worker looks again once it is a month old.
CREATE TABLE IF NOT EXISTS lyrics (
  song_id TEXT PRIMARY KEY,
  synced TEXT,
  plain TEXT,
  checked_at INTEGER NOT NULL
);
