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

async function testAcquireLock(matchId) {
    const lockId = require('crypto').randomUUID();
    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000).toISOString();

    console.log(`\nAttempting to acquire lock for ${matchId}...`);
    console.log(`Lock ID: ${lockId}`);
    console.log(`Two minutes ago: ${twoMinutesAgo}`);

    const { data, error } = await supabase
        .from("matches")
        .update({
            payout_status: "PROCESSING",
            settlement_lock_id: lockId,
            updated_at: now.toISOString(),
        })
        .eq("id", matchId)
        .not("payout_status", "in", `(${FINALIZED.map(s => `"${s}"`).join(",")})`)
        .or(`settlement_lock_id.is.null,updated_at.lt."${twoMinutesAgo}"`)
        .select()
        .maybeSingle();

    if (error) {
        console.error(`❌ acquireLock Error: ${error.code} - ${error.message} - ${error.details}`);
        return null;
    }

    if (data) {
        console.log(`✅ Lock acquired successfully!`);
        console.log(`   Status: ${data.status}`);
        console.log(`   Payout Status: ${data.payout_status}`);
        console.log(`   Lock ID: ${data.settlement_lock_id}`);
    } else {
        console.log(`⏭️ Could not acquire lock (no data returned)`);

        // Fetch current state to understand why
        const { data: current } = await supabase
            .from("matches")
            .select("status, payout_status, settlement_lock_id, updated_at")
            .eq("id", matchId)
            .single();

        if (current) {
            console.log(`\nCurrent match state:`);
            console.log(`   Status: ${current.status}`);
            console.log(`   Payout Status: ${current.payout_status}`);
            console.log(`   Lock ID: ${current.settlement_lock_id}`);
            console.log(`   Updated At: ${current.updated_at}`);

            const updatedAtTime = new Date(current.updated_at).getTime();
            const twoMinutesAgoTime = new Date(twoMinutesAgo).getTime();
            console.log(`\n   updated_at is ${updatedAtTime < twoMinutesAgoTime ? 'OLDER' : 'NEWER'} than 2 minutes ago`);
            console.log(`   Lock is ${current.settlement_lock_id ? 'SET' : 'NULL'}`);
            console.log(`   Payout status is ${FINALIZED.includes(current.payout_status) ? 'FINALIZED' : 'NOT finalized'}`);
        }
    }

    return data ?? null;
}

testAcquireLock(MATCH_ID);
