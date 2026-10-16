-- The schema the Worker's request-time DDL (the removed ensure* functions) built before 0012, statement
-- for statement as it ran on production D1. Used by scripts/d1-migrations.node-test.mjs to check that
-- d1-baseline.sh plus 0012 brings such a database up to date. release_metadata starts in its first shape
-- and gains its later columns through the ALTER TABLEs, as it did in production. ALTER TABLEs that always
-- failed (the column was already in the CREATE TABLE) are left out.
CREATE TABLE IF NOT EXISTS release_metadata (album_id TEXT PRIMARY KEY, release_type TEXT NOT NULL, release_date TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by TEXT);
CREATE TABLE IF NOT EXISTS release_metadata (album_id TEXT PRIMARY KEY, release_type TEXT NOT NULL, release_date TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by TEXT, source TEXT NOT NULL DEFAULT 'manual', musicbrainz_id TEXT, match_score INTEGER);
ALTER TABLE release_metadata ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE release_metadata ADD COLUMN musicbrainz_id TEXT;
ALTER TABLE release_metadata ADD COLUMN match_score INTEGER;
CREATE TABLE IF NOT EXISTS recovery_items (id TEXT PRIMARY KEY, username TEXT NOT NULL, artist TEXT NOT NULL, title TEXT NOT NULL, album TEXT, duration REAL, track_number INTEGER, disc_number INTEGER, musicbrainz_id TEXT, metadata_resolution_json TEXT, artwork_resolution_json TEXT, source_json TEXT, status TEXT NOT NULL DEFAULT 'missing', notes TEXT, error TEXT, selected_candidate_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS recovery_candidates (id TEXT PRIMARY KEY, recovery_id TEXT NOT NULL, backend TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, channel TEXT NOT NULL, channel_id TEXT, duration REAL, official INTEGER NOT NULL DEFAULT 0, match_score INTEGER NOT NULL DEFAULT 0, thumbnail TEXT, codec TEXT, container TEXT, bitrate INTEGER, sample_rate INTEGER, channels INTEGER, imported_path TEXT, provenance_json TEXT, rights_basis TEXT, selected INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_recovery_items_username_status ON recovery_items(username, status);
CREATE INDEX IF NOT EXISTS idx_recovery_candidates_recovery ON recovery_candidates(recovery_id, match_score DESC);
ALTER TABLE recovery_items ADD COLUMN playback_json TEXT;
CREATE TABLE IF NOT EXISTS catalogue_playlists (id TEXT PRIMARY KEY, username TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, provider_playlist_id TEXT NOT NULL, source_url TEXT NOT NULL, snapshot_id TEXT, artwork_url TEXT, provenance_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS catalogue_playlist_items (id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL, position INTEGER NOT NULL, provider_track_id TEXT, metadata_json TEXT NOT NULL, status TEXT NOT NULL, local_track_id TEXT, local_track_json TEXT, recovery_id TEXT, match_confidence INTEGER NOT NULL DEFAULT 0, user_confirmed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS catalogue_oauth_states (state TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS catalogue_provider_tokens (username TEXT NOT NULL, provider TEXT NOT NULL, encrypted_token TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (username, provider));
CREATE INDEX IF NOT EXISTS idx_catalogue_playlists_user ON catalogue_playlists(username, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_catalogue_playlists_source ON catalogue_playlists(username, provider, provider_playlist_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalogue_playlist_position ON catalogue_playlist_items(playlist_id, position);
CREATE TABLE IF NOT EXISTS release_tracklists (album_id TEXT PRIMARY KEY, release_id TEXT NOT NULL, release_group_id TEXT, source TEXT NOT NULL, tracklist_json TEXT NOT NULL, editions_json TEXT, fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by TEXT);
CREATE TABLE IF NOT EXISTS album_artwork (album_id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT, url TEXT, width INTEGER, height INTEGER, confidence INTEGER, source TEXT NOT NULL, provider_album TEXT, provider_artist TEXT, store_url TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by TEXT);
CREATE TABLE IF NOT EXISTS album_artwork_uploads (id TEXT PRIMARY KEY, album_id TEXT NOT NULL, content_type TEXT NOT NULL, data TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, uploaded_by TEXT);
CREATE TABLE IF NOT EXISTS playlist_shares (kind TEXT NOT NULL, playlist_id TEXT NOT NULL, owner TEXT NOT NULL, shared_with TEXT NOT NULL, playlist_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (kind, playlist_id, shared_with));
CREATE INDEX IF NOT EXISTS idx_playlist_shares_recipient ON playlist_shares(shared_with);
CREATE TABLE IF NOT EXISTS tomify_accounts (username TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS live_playback (username TEXT PRIMARY KEY, device_id TEXT NOT NULL, device_name TEXT NOT NULL, state_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, command_json TEXT, command_revision INTEGER NOT NULL DEFAULT 0, command_target_device TEXT, command_updated_at INTEGER);
CREATE TABLE IF NOT EXISTS live_playback_devices (username TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (username, device_id));
CREATE TABLE IF NOT EXISTS tomify_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by TEXT);
