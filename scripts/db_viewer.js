const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const dotenv = require('dotenv');

// Load env vars
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing Supabase credentials in .env.local");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const fs = require('fs');

async function viewDb() {
    const { data: matches } = await supabase
        .from('matches')
        .select('id, contract_match_id, status, p1_deposited, p2_deposited, server_id, created_at')
        .order('created_at', { ascending: false })
        .limit(10);

    const { data: servers } = await supabase
        .from('game_servers')
        .select('id, name, status, current_match_id');

    fs.writeFileSync('c:/Users/rjega/arcade-nexus/db_dump.json', JSON.stringify({ matches, servers }, null, 2));
    console.log("Dumped to db_dump.json");
}

viewDb();
