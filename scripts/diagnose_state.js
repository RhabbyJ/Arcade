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
        break;
    }
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
    const matchId = 'dc9f316c-6f58-40c9-a5e0-44ac141aa959';
    console.log(`Diagnosing Match: ${matchId}`);

    const { data, error } = await supabase
        .from('matches')
        .select('*')
        .eq('id', matchId)
        .single();

    if (error) {
        console.error("Error fetching match:", error);
    } else {
        console.log("Match State:");
        console.log(JSON.stringify({
            id: data.id,
            status: data.status,
            payout_status: data.payout_status,
            settlement_lock_id: data.settlement_lock_id,
            updated_at: data.updated_at,
            server_id: data.server_id
        }, null, 2));
    }
}

main();
