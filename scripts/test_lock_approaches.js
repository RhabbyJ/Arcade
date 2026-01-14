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

async function testLockApproaches() {
    const lockId = require('crypto').randomUUID();
    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000).toISOString();

    console.log(`\n=== TEST LOCK APPROACHES ===\n`);

    // First reset the match state
    await supabase.from("matches").update({
        settlement_lock_id: null,
        payout_status: "PENDING",
        updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() // 5 min ago
    }).eq("id", MATCH_ID);
    console.log("Reset match state");

    // Approach 1: Two-step check-then-update
    console.log("\n--- APPROACH 1: Two-step (check then update) ---");
    const { data: check } = await supabase
        .from("matches")
        .select("id, payout_status, settlement_lock_id, updated_at")
        .eq("id", MATCH_ID)
        .not("payout_status", "in", `(${FINALIZED.map(s => `"${s}"`).join(",")})`)
        .or(`settlement_lock_id.is.null,updated_at.lt."${twoMinutesAgo}"`)
        .maybeSingle();

    if (check) {
        console.log("Match passed filter check:", check.id);
        const { data: updated, error } = await supabase
            .from("matches")
            .update({
                payout_status: "PROCESSING",
                settlement_lock_id: lockId,
                updated_at: now.toISOString(),
            })
            .eq("id", MATCH_ID)
            .eq("settlement_lock_id", check.settlement_lock_id) // Optimistic lock
            .select()
            .maybeSingle();

        if (error) console.error("Update error:", error);
        else if (updated) console.log("✅ Lock acquired:", updated.settlement_lock_id);
        else console.log("❌ Lock acquisition failed (concurrent update?)");
    } else {
        console.log("Match did not pass filter check");
    }

    // Reset for next test
    await supabase.from("matches").update({
        settlement_lock_id: null,
        payout_status: "PENDING",
        updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString()
    }).eq("id", MATCH_ID);

    // Approach 2: RPC function (most robust)
    console.log("\n--- APPROACH 2: Would use RPC but requires DB function ---");
    console.log("Skipped - needs database function");

    // Approach 3: Use .is() instead of .or() for null check only
    console.log("\n--- APPROACH 3: Just null check (simplified) ---");
    const { data: t3, error: e3 } = await supabase
        .from("matches")
        .update({
            payout_status: "PROCESSING",
            settlement_lock_id: lockId,
            updated_at: now.toISOString(),
        })
        .eq("id", MATCH_ID)
        .not("payout_status", "in", `(${FINALIZED.map(s => `"${s}"`).join(",")})`)
        .is("settlement_lock_id", null)
        .select()
        .maybeSingle();

    if (e3) console.error("Error:", e3);
    else if (t3) console.log("✅ Lock acquired (null check only):", t3.settlement_lock_id);
    else console.log("❌ Lock not acquired");
}

testLockApproaches();
