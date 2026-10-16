-- Library health findings an administrator has marked as fine (for example the same edit on two singles in a
-- box set). A finding is identified by its report category and its sorted file or folder paths, so it comes back
-- if those paths change.
CREATE TABLE IF NOT EXISTS library_health_dismissals (
  category TEXT NOT NULL,
  paths_key TEXT NOT NULL,
  label TEXT,
  dismissed_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (category, paths_key)
);
