const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const dotenv = require('dotenv');

// Load .env
const envLocalPath = path.resolve(__dirname, '../.env.local');
const envPath = path.resolve(__dirname, '../.env');
const config = { quiet: true };
dotenv.config({ path: envLocalPath, ...config });
dotenv.config({ path: envPath, ...config });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing Supabase credentials in .env");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function checkGameServers() {
    console.log("Checking game_servers table...");
    const { data, error } = await supabase
        .from('game_servers')
        .select('*');

    if (error) {
        console.error("Error querying game_servers:", error.message);
        return;
    }

    if (!data || data.length === 0) {
        console.log("No game servers found.");
        return;
    }

    console.log(`Found ${data.length} server(s):`);
    data.forEach(server => {
        console.log(`- ID: ${server.id}`);
        console.log(`  Name: ${server.name}`);
        console.log(`  IP: ${server.ip} (${typeof server.ip})`);
        console.log(`  Port: ${server.port} (${typeof server.port})`);
        console.log(`  Status: ${server.status}`);
        console.log('---');
    });
}

checkGameServers();
