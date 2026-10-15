CREATE TABLE IF NOT EXISTS album_artwork (
  album_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_id TEXT,
  url TEXT,
  width INTEGER,
  height INTEGER,
  confidence INTEGER,
  source TEXT NOT NULL,
  provider_album TEXT,
  provider_artist TEXT,
  store_url TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);
