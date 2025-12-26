-- Server-Side Architecture: Database Upgrade
-- Adds columns for tx_hash logging, deposit verification, and server assignment

-- Transaction Hash Logging (Audit Trail)
ALTER TABLE matches ADD COLUMN IF NOT EXISTS p1_tx_hash TEXT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS p2_tx_hash TEXT;

-- Deposit Verification (Bot sets these, not frontend)
ALTER TABLE matches ADD COLUMN IF NOT EXISTS p1_deposited BOOLEAN DEFAULT FALSE;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS p2_deposited BOOLEAN DEFAULT FALSE;

-- Server Assignment (Decoupled from immediate match creation)
ALTER TABLE matches ADD COLUMN IF NOT EXISTS server_id UUID;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS server_assigned_at TIMESTAMPTZ;

-- Add index for bot polling efficiency
CREATE INDEX IF NOT EXISTS idx_matches_depositing 
ON matches (status) 
WHERE status = 'DEPOSITING';

-- Add index for timeout checks
CREATE INDEX IF NOT EXISTS idx_matches_created_at 
ON matches (created_at) 
WHERE status IN ('WAITING', 'DEPOSITING');
