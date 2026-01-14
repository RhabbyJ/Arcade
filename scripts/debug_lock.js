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

// FINALIZED list from payout_cron.js
const FINALIZED = ["PAID", "REFUNDED", "ACCEPTED"];

async function main() {
    const matchId = 'dc9f316c-6f58-40c9-a5e0-44ac141aa959';
    console.log(`Testing lock for ${matchId}...`);

    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000).toISOString();

    console.log("--- TEST 1: Simple Update (Sanity Check) ---");
    const { error: e1 } = await supabase.from('matches').update({ updated_at: now.toISOString() }).eq('id', matchId);
    if (e1) console.error("Test 1 Failed:", e1); else console.log("Test 1 OK");

    console.log("--- TEST 2: Payout Status NOT IN ---");
    // Test Double Quotes
    const filter = `(${FINALIZED.map(s => `"${s}"`).join(",")})`;
    const { error: e2 } = await supabase.from('matches').select('id').eq('id', matchId).not('payout_status', 'in', filter);
    if (e2) console.error("Test 2 (Double Quotes) Failed:", e2.code, e2.message); else console.log("Test 2 (Double Quotes) OK");

    // Test No Quotes
    const filterNoQuotes = `(${FINALIZED.join(",")})`;
    const { error: e2b } = await supabase.from('matches').select('id').eq('id', matchId).not('payout_status', 'in', filterNoQuotes);
    if (e2b) console.error("Test 2 (No Quotes) Failed:", e2b.code, e2b.message); else console.log("Test 2 (No Quotes) OK");

    console.log("--- TEST 3: OR Timestamp Filter ---");
    // Test Double Quotes
    const orDouble = `settlement_lock_id.is.null,updated_at.lt."${twoMinutesAgo}"`;
    const { error: e3 } = await supabase.from('matches').select('id').eq('id', matchId).or(orDouble);
    if (e3) console.error("Test 3 (Double Quotes) Failed:", e3.code, e3.message); else console.log("Test 3 (Double Quotes) OK");

    // Test Minimal format (no Quotes)
    // Postgrest allows raw strings if no specials?? But ISO string has colons.
    // Try simple date NO TIME to test syntax
    const simpleDate = "2025-01-01";
    const orSimple = `settlement_lock_id.is.null,updated_at.lt.${simpleDate}`;
    const { error: e3simple } = await supabase.from('matches').select('id').eq('id', matchId).or(orSimple);
    if (e3simple) console.error("Test 3 (Simple Date) Failed:", e3simple.code, e3simple.message); else console.log("Test 3 (Simple Date) OK");
}

main();
