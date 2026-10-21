-- Collaborative playlists: a share can let the recipient add, remove and reorder songs.
ALTER TABLE playlist_shares ADD COLUMN can_edit INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Navidrome only lets a playlist's owner change it, so an owner who has editors keeps their Navidrome token
-- here, sealed with TOMIFY_MEDIA_KEY. It is refreshed whenever they open Tomify and deleted when the last editor goes.
CREATE TABLE IF NOT EXISTS playlist_owner_logins (
  owner TEXT PRIMARY KEY,
  credential TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
