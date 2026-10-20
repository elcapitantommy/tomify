-- Genre of each play, so listening stats and Wrapped can show top genres. Older plays have none.
ALTER TABLE listening_events ADD COLUMN genre TEXT;

-- A year's Wrapped recap, saved before that year's plays are pruned (listening_events keeps about 400 days),
-- so past years stay viewable and the next year can be compared with it.
CREATE TABLE IF NOT EXISTS listening_years (
  username TEXT NOT NULL,
  year INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (username, year)
);
