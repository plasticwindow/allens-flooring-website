CREATE TABLE IF NOT EXISTS contact_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0 CHECK (marketing_consent IN (0, 1)),
  consent_at INTEGER,
  submitted_at INTEGER NOT NULL,
  form_source TEXT NOT NULL CHECK (form_source IN ('/', '/contact', 'unknown')),
  CHECK (
    (marketing_consent = 0 AND consent_at IS NULL) OR
    (marketing_consent = 1 AND consent_at IS NOT NULL)
  )
);
