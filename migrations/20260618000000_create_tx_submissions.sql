-- Durable queue for in-flight Soroban transaction submissions
CREATE TABLE IF NOT EXISTS tx_submissions (
  id VARCHAR(64) PRIMARY KEY,
  job_type VARCHAR(128) NOT NULL,
  payload_fingerprint VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  delay_until_ms BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tx_submissions_status
  ON tx_submissions (status);

CREATE INDEX IF NOT EXISTS idx_tx_submissions_non_terminal
  ON tx_submissions (status, created_at ASC)
  WHERE status IN ('pending', 'processing', 'retrying');
