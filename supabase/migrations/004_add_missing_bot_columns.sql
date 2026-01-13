
-- Migration: Add missing columns for bot reliability
-- Description: Adds start_attempts, last_settlement_error, and lock columns.

ALTER TABLE matches 
ADD COLUMN IF NOT EXISTS start_attempts INTEGER DEFAULT 0;

ALTER TABLE matches 
ADD COLUMN IF NOT EXISTS last_settlement_error TEXT;

ALTER TABLE matches 
ADD COLUMN IF NOT EXISTS match_start_lock_id TEXT;

ALTER TABLE matches 
ADD COLUMN IF NOT EXISTS settlement_lock_id TEXT;

ALTER TABLE matches 
ADD COLUMN IF NOT EXISTS settlement_attempts INTEGER DEFAULT 0;

-- Ensure server_connect and dathost_status_snapshot are there too, just in case 003 wasn't run.
ALTER TABLE matches 
ADD COLUMN IF NOT EXISTS server_connect TEXT;

ALTER TABLE matches 
ADD COLUMN IF NOT EXISTS dathost_status_snapshot JSONB;
