-- Album covers an administrator uploads from their device (base64, at most 1 MB decoded).
-- The Worker also creates this table on first use.
CREATE TABLE IF NOT EXISTS album_artwork_uploads (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  data TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  uploaded_by TEXT
);
