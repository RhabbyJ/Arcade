
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');

// Load env vars
const envPaths = [
    path.resolve(__dirname, '../.env.local'),
    path.resolve('/root/base-bot/.env'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env')
];
for (const p of envPaths) {
    if (fs.existsSync(p)) {
        dotenv.config({ path: p });
        console.log(`Loaded env from: ${p}`);
        break;
    }
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing Supabase credentials");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
    console.log("\n--- Game Servers ---");
    const { data: servers, error: sErr } = await supabase.from('game_servers').select('*');
    if (sErr) console.error("Error fetching servers:", sErr);
    else console.log(JSON.stringify(servers, null, 2));

    const { data: matches, error: mErr } = await supabase.from('matches')
        .select('*')
        .eq('id', 'dc9f316c-6f58-40c9-a5e0-44ac141aa959');

    if (mErr) console.error("Error fetching matches:", mErr);
    else {
        matches.forEach(m => {
            console.log(`\nMatch ID: ${m.id}`);
            console.log(`Status: ${m.status}`);
            console.log(`Match Started At: ${m.match_started_at}`);
            console.log(`Server Connect: ${m.server_connect}`);
            console.log(`DatHost Snapshot Included: ${!!m.dathost_status_snapshot}`);
            if (m.dathost_status_snapshot) {
                const fs = require('fs');
                fs.writeFileSync('snapshot_debug.json', JSON.stringify(m.dathost_status_snapshot, null, 2));
                console.log('Snapshot written to snapshot_debug.json');
            }
        });
    }
}

main();
