-- Add refund_tx_hash column for UI display
ALTER TABLE matches ADD COLUMN IF NOT EXISTS refund_tx_hash TEXT;
