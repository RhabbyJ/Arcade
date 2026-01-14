-- Add WAITING_FOR_PLAYERS to match_status enum
-- This state indicates the server is successfully acquired and booted,
-- and is now waiting for players to connect and ready up.

ALTER TYPE match_status ADD VALUE IF NOT EXISTS 'WAITING_FOR_PLAYERS';
