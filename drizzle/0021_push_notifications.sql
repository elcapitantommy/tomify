-- Push notifications. Each browser that turns them on is one subscription, with the topics it wants.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  topics TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (username);
--> statement-breakpoint
-- The Worker's VAPID key pair, made on first use so there is nothing to set up.
CREATE TABLE IF NOT EXISTS push_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  subject TEXT NOT NULL
);
--> statement-breakpoint
-- Recovery jobs already announced, so each finished download is announced once.
CREATE TABLE IF NOT EXISTS push_recovery_sent (
  job_id TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL
);
