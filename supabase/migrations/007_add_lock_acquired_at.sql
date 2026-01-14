-- Add lock_acquired_at column for better stale lock detection
-- This prevents "ghost locks" where repeated polling refreshes updated_at
-- but the original lock holder is gone

ALTER TABLE matches
ADD COLUMN IF NOT EXISTS lock_acquired_at TIMESTAMPTZ;

-- Add an index for efficient stale lock queries
CREATE INDEX IF NOT EXISTS idx_matches_lock_acquired_at 
ON matches(lock_acquired_at) 
WHERE lock_acquired_at IS NOT NULL;
