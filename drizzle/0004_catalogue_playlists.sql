ALTER TABLE recovery_items ADD COLUMN source_json TEXT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS catalogue_playlists (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_playlist_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  snapshot_id TEXT,
  artwork_url TEXT,
  provenance_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_catalogue_playlists_user ON catalogue_playlists(username, updated_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_catalogue_playlists_source ON catalogue_playlists(username, provider, provider_playlist_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS catalogue_playlist_items (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  provider_track_id TEXT,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL,
  local_track_id TEXT,
  local_track_json TEXT,
  recovery_id TEXT,
  match_confidence INTEGER NOT NULL DEFAULT 0,
  user_confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalogue_playlist_position ON catalogue_playlist_items(playlist_id, position);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS catalogue_oauth_states (state TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS catalogue_provider_tokens (username TEXT NOT NULL, provider TEXT NOT NULL, encrypted_token TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (username, provider));
--> statement-breakpoint
PRAGMA optimize;
