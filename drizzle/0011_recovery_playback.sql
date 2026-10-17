-- Whether a recovered import is playable yet: JSON with state scan-pending, ready (with the Navidrome song id)
-- or scan-failed. The Worker also adds this column on first use (ensureRecoveryTables), so deploying needs no
-- extra step. See scripts/library-scan-worker.mjs.
ALTER TABLE recovery_items ADD COLUMN playback_json TEXT;
