CREATE TABLE IF NOT EXISTS playlist_shares (
  kind TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  shared_with TEXT NOT NULL,
  playlist_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (kind, playlist_id, shared_with)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_playlist_shares_recipient ON playlist_shares(shared_with);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tomify_accounts (
  username TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
