-- New releases from artists in the library. Tomify's pages send the library's artists (Navidrome is not
-- reachable from the daily cron without a login); the cron checks the oldest-checked ones on MusicBrainz.
CREATE TABLE IF NOT EXISTS new_release_artists (
  artist_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  musicbrainz_id TEXT,
  checked_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS new_release_artists_checked ON new_release_artists (checked_at);

-- One row per MusicBrainz release group first released within the last year (or announced).
CREATE TABLE IF NOT EXISTS new_releases (
  release_group_id TEXT PRIMARY KEY,
  artist_key TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  title TEXT NOT NULL,
  release_type TEXT NOT NULL,
  release_date TEXT NOT NULL,
  found_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS new_releases_date ON new_releases (release_date);
