-- Party mode: a host shares a queue that guests join with an access code and add tracks to from their phones.
-- credential is the host's Navidrome token and salt, sealed with TOMIFY_MEDIA_KEY, so the Worker can search the
-- library for guests. It is deleted with the party.
CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  credential TEXT NOT NULL DEFAULT '',
  cooldown_seconds INTEGER NOT NULL DEFAULT 0,
  max_per_guest INTEGER NOT NULL DEFAULT 3,
  voting INTEGER NOT NULL DEFAULT 1,
  now_playing_json TEXT,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS party_guests (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  last_added_at INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_guests_party ON party_guests (party_id);
-- state: pending (waiting, guests can vote), queued (the host's player has it up next), played.
CREATE TABLE IF NOT EXISTS party_queue (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  guest_id TEXT,
  guest_name TEXT NOT NULL,
  track_id TEXT NOT NULL,
  track_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  added_at INTEGER NOT NULL,
  state_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_queue_party ON party_queue (party_id, state);
CREATE TABLE IF NOT EXISTS party_votes (
  item_id TEXT NOT NULL,
  guest_id TEXT NOT NULL,
  PRIMARY KEY (item_id, guest_id)
);
