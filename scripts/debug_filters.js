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
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const FINALIZED = ["PAID", "REFUNDED"];
const MATCH_ID = 'dc9f316c-6f58-40c9-a5e0-44ac141aa959';

async function debugFilters() {
    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000).toISOString();

    console.log(`\n=== DEBUG FILTERS FOR ${MATCH_ID} ===\n`);
    console.log(`Two minutes ago: ${twoMinutesAgo}`);

    // Test 1: Select with just .eq
    console.log("\n--- TEST 1: Simple eq ---");
    const { data: t1, error: e1 } = await supabase
        .from("matches")
        .select("id, status, payout_status, settlement_lock_id, updated_at")
        .eq("id", MATCH_ID);
    if (e1) console.error("Error:", e1);
    else console.log("Result:", t1);

    // Test 2: Add .not payout_status
    console.log("\n--- TEST 2: With .not payout_status ---");
    const filterStr = `(${FINALIZED.map(s => `"${s}"`).join(",")})`;
    console.log(`Filter string: ${filterStr}`);
    const { data: t2, error: e2 } = await supabase
        .from("matches")
        .select("id, payout_status")
        .eq("id", MATCH_ID)
        .not("payout_status", "in", filterStr);
    if (e2) console.error("Error:", e2);
    else console.log("Result:", t2);

    // Test 3: Add .or settlement_lock_id.is.null
    console.log("\n--- TEST 3: With .or settlement_lock_id.is.null ---");
    const { data: t3, error: e3 } = await supabase
        .from("matches")
        .select("id, settlement_lock_id")
        .eq("id", MATCH_ID)
        .or("settlement_lock_id.is.null");
    if (e3) console.error("Error:", e3);
    else console.log("Result:", t3);

    // Test 4: Full .or condition
    console.log("\n--- TEST 4: Full .or condition ---");
    const orStr = `settlement_lock_id.is.null,updated_at.lt."${twoMinutesAgo}"`;
    console.log(`OR string: ${orStr}`);
    const { data: t4, error: e4 } = await supabase
        .from("matches")
        .select("id, settlement_lock_id, updated_at")
        .eq("id", MATCH_ID)
        .or(orStr);
    if (e4) console.error("Error:", e4);
    else console.log("Result:", t4);

    // Test 5: All conditions together (SELECT only)
    console.log("\n--- TEST 5: Combined SELECT (simulating UPDATE filter) ---");
    const { data: t5, error: e5 } = await supabase
        .from("matches")
        .select("id, status, payout_status, settlement_lock_id, updated_at")
        .eq("id", MATCH_ID)
        .not("payout_status", "in", filterStr)
        .or(orStr);
    if (e5) console.error("Error:", e5);
    else console.log("Result:", t5);

    // Test 6: Just try update without filters
    console.log("\n--- TEST 6: UPDATE with only .eq (no filters) ---");
    const { data: t6, error: e6 } = await supabase
        .from("matches")
        .update({ updated_at: now.toISOString() })
        .eq("id", MATCH_ID)
        .select("id, updated_at");
    if (e6) console.error("Error:", e6);
    else console.log("Result:", t6);
}

debugFilters();
