
-- Migration: Add missing columns to matches table
-- Description: Adds server_connect and ensures dathost_status_snapshot exists.

ALTER TABLE matches 
ADD COLUMN IF NOT EXISTS server_connect TEXT;

ALTER TABLE matches 
ADD COLUMN IF NOT EXISTS dathost_status_snapshot JSONB;

-- Comment: This fixes the "Could not find column" error preventing match start.
