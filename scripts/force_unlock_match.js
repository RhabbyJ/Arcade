
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

const MATCH_ID = 'dc9f316c-6f58-40c9-a5e0-44ac141aa959';

async function main() {
    console.log(`Attempting to unlock match: ${MATCH_ID}`);

    const { data: match, error: fetchError } = await supabase
        .from('matches')
        .select('*')
        .eq('id', MATCH_ID)
        .single();

    if (fetchError) {
        console.error("Error fetching match:", fetchError);
        return;
    }

    console.log("\nCurrent State:");
    console.log(`- Status: ${match.status}`);
    console.log(`- Payout Status: ${match.payout_status}`);
    console.log(`- Lock ID: ${match.settlement_lock_id}`);
    console.log(`- Updated At: ${match.updated_at}`);

    console.log("\nUnlocking...");

    const { error: updateError } = await supabase
        .from('matches')
        .update({
            settlement_lock_id: null,
            payout_status: 'PENDING', // Reset to PENDING to be safe
            settlement_attempts: 0,   // Reset attempts to allow retry
            // Force updated_at to be old? No, logic checks (Lock match OR Lock is Old).
            // If Lock is NULL, it will pass.
        })
        .eq('id', MATCH_ID);

    if (updateError) {
        console.error("❌ Failed to unlock:", updateError);
    } else {
        console.log("✅ Match unlocked successfully!");
        console.log("The Janitor should pick this up in < 30 seconds.");
    }
}

main();
