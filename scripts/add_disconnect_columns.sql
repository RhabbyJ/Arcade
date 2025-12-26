/*
    RUN THIS IN SUPABASE SQL EDITOR
    
    This adds columns to track when a player disconnects.
    If NULL, the player is connected.
    If SET, the player is disconnected since that time.
*/

ALTER TABLE matches 
ADD COLUMN player1_disconnect_time TIMESTAMPTZ DEFAULT NULL,
ADD COLUMN player2_disconnect_time TIMESTAMPTZ DEFAULT NULL;
