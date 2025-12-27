-- Add deposit_started_at column for accurate timer
ALTER TABLE matches ADD COLUMN IF NOT EXISTS deposit_started_at TIMESTAMPTZ;
