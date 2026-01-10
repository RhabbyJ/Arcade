-- Settlement fields for atomic locking and reconciliation
ALTER TABLE matches 
ADD COLUMN IF NOT EXISTS dathost_match_id text,
ADD COLUMN IF NOT EXISTS payout_event_id text,
ADD COLUMN IF NOT EXISTS payout_tx_hash text,
ADD COLUMN IF NOT EXISTS refund_tx_hash_1 text,
ADD COLUMN IF NOT EXISTS refund_tx_hash_2 text,
ADD COLUMN IF NOT EXISTS settlement_attempts int DEFAULT 0,
ADD COLUMN IF NOT EXISTS settled_at timestamptz,
ADD COLUMN IF NOT EXISTS dathost_status_snapshot jsonb,
ADD COLUMN IF NOT EXISTS last_settlement_error text,
ADD COLUMN IF NOT EXISTS settlement_lock_id text,
ADD COLUMN IF NOT EXISTS settlement_kind text;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_matches_dathost_match_id ON matches(dathost_match_id);
CREATE INDEX IF NOT EXISTS idx_matches_payout_status ON matches(payout_status);

-- Match events audit table (bank-grade logging)
CREATE TABLE IF NOT EXISTS match_events (
  id bigserial PRIMARY KEY,
  match_id uuid NOT NULL,
  source text NOT NULL, -- 'dathost_webhook' | 'janitor_poll' | 'manual'
  event_type text NOT NULL,
  event_id text,
  payload jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_match_events_match_id ON match_events(match_id);
CREATE INDEX IF NOT EXISTS idx_match_events_created_at ON match_events(created_at);
