CREATE TABLE IF NOT EXISTS recovery_items (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  album TEXT,
  duration REAL,
  track_number INTEGER,
  disc_number INTEGER,
  musicbrainz_id TEXT,
  status TEXT NOT NULL DEFAULT 'missing',
  notes TEXT,
  error TEXT,
  selected_candidate_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS recovery_candidates (
  id TEXT PRIMARY KEY,
  recovery_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_id TEXT,
  duration REAL,
  official INTEGER NOT NULL DEFAULT 0,
  match_score INTEGER NOT NULL DEFAULT 0,
  thumbnail TEXT,
  codec TEXT,
  container TEXT,
  bitrate INTEGER,
  sample_rate INTEGER,
  channels INTEGER,
  imported_path TEXT,
  provenance_json TEXT,
  rights_basis TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_recovery_items_username_status ON recovery_items(username, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_recovery_candidates_recovery ON recovery_candidates(recovery_id, match_score DESC);
--> statement-breakpoint
PRAGMA optimize;
