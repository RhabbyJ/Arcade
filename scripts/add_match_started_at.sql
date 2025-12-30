-- Add match_started_at column to track when match actually starts (after 30s warmup)
-- This differentiates between status='LIVE' (assigned to server) and actually playing

ALTER TABLE matches 
ADD COLUMN IF NOT EXISTS match_started_at TIMESTAMPTZ;

COMMENT ON COLUMN matches.match_started_at IS 'Timestamp when match actually started (after 30s warmup + forceready)';
