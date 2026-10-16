-- Site-wide settings, one row per key. `quality_target` (lossless, transparent-lossy or lossy) is the
-- preferred quality for Recovery; it defaults to transparent-lossy when absent. The Worker also creates
-- this table on first use (scripts/quality-worker.mjs), so deploying needs no extra step.
CREATE TABLE IF NOT EXISTS tomify_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);
