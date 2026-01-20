
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
    console.log("\n--- Checking for Stuck/Queued Matches ---");
    const { data: stuckMatches, error } = await supabase
        .from("matches")
        .select("*")
        .in("status", ["DATHOST_BOOTING", "WAITING_FOR_PLAYERS", "LIVE", "CANCELLED", "COMPLETE"])
        .not("payout_status", "in", '("PAID","REFUNDED")')
        .lt("settlement_attempts", 10);

    if (error) {
        console.error("Error fetching stuck matches:", error);
        return;
    }

    if (stuckMatches.length === 0) {
        console.log("✅ No stuck matches found.");
    } else {
        console.log(`⚠️ Found ${stuckMatches.length} stuck matches:`);
        stuckMatches.forEach(m => {
            console.log(`\n------------------------------------------------`);
            console.log(`Match ID: ${m.id}`);
            console.log(`Status: ${m.status}`);
            console.log(`Payout Status: ${m.payout_status}`);
            console.log(`Settlement Attempts: ${m.settlement_attempts}`);
            console.log(`Last Error: ${m.last_settlement_error}`);
            console.log(`Refund TX 1: ${m.refund_tx_hash_1}`);
            console.log(`Refund TX 2: ${m.refund_tx_hash_2}`);
            console.log(`Payout TX: ${m.payout_tx_hash}`);
        });
    }
}

main();
