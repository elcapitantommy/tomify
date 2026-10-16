-- Cross-device playback: the device that owns playback per account (plus recent remote commands),
-- and which of the account's devices are open right now. The Worker also creates both tables on first use.
CREATE TABLE IF NOT EXISTS live_playback (
  username TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  state_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  command_json TEXT,
  command_revision INTEGER NOT NULL DEFAULT 0,
  command_target_device TEXT,
  command_updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS live_playback_devices (
  username TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (username, device_id)
);
