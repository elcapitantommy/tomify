-- Rule-based playlists. Only the rules are stored: the browser evaluates them against the library when the
-- playlist is opened, so the tracks always reflect what is in the library and what has been played.
CREATE TABLE IF NOT EXISTS smart_playlists (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS smart_playlists_user ON smart_playlists (username, name);
