-- Add UNIQUE constraint to dathost_id
ALTER TABLE game_servers 
ADD CONSTRAINT game_servers_dathost_id_unique UNIQUE (dathost_id);

-- Insert your DatHost server
INSERT INTO game_servers (dathost_id, name, ip, port, status)
VALUES ('692b5cc203632a85c6fdba2c', 'Primary Server', 'blindspot.dathost.net', 26893, 'FREE')
ON CONFLICT (dathost_id) DO NOTHING;
