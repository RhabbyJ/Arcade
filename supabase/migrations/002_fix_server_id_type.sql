-- Fix server_id type mismatch
-- matches.server_id is UUID, but game_servers.id is BIGINT
-- We must convert it. Data will be lost in this column (set to NULL) because UUIDs cannot be cast to integers.

ALTER TABLE matches 
ALTER COLUMN server_id TYPE bigint USING NULL;

-- Add foreign key constraint
ALTER TABLE matches
ADD CONSTRAINT matches_server_id_fkey FOREIGN KEY (server_id) REFERENCES game_servers(id);
