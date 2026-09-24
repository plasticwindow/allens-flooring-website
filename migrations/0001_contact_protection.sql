CREATE TABLE IF NOT EXISTS contact_rate_limits (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contact_submission_fingerprints (
  fingerprint TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS contact_rate_limits_expiry ON contact_rate_limits (expires_at);
CREATE INDEX IF NOT EXISTS contact_submission_fingerprints_expiry ON contact_submission_fingerprints (expires_at);
