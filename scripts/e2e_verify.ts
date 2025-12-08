import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import fetch from 'node-fetch'; // You might need to install: npm install node-fetch @types/node-fetch

// 1. Setup Environment
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const BASE_URL = "http://localhost:3000"; // Ensure your Next.js app is running!

if (!WEBHOOK_SECRET) {
    console.error("❌ Missing WEBHOOK_SECRET in .env.local");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helper to delay execution
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log("🚀 STARTING E2E VERIFICATION FLOW...\n");

    try {
        // --- STEP 1: SETUP STATE ---
        console.log("1️⃣  Creating Test Match & Resetting Servers...");

        // Reset any existing busy servers for a clean slate
        await supabase.from('game_servers').update({ status: 'FREE', current_match_id: null }).neq('status', 'OFFLINE');

        // Create a match ready for the test (Simulating 'DEPOSITING' complete)
        const { data: match, error: matchError } = await supabase
            .from('matches')
            .insert({
                player1_address: "0x1111111111111111111111111111111111111111", // Test Address
                player2_address: "0x2222222222222222222222222222222222222222",
                player1_steam: "STEAM_0:1:12345678", // Winner Steam ID
                player2_steam: "STEAM_0:1:87654321", // Loser
                contract_match_id: "9999", // Mock Contract ID
                status: 'LIVE', // Logic requires LIVE status for webhook to act
                payout_status: 'PENDING'
            })
            .select()
            .single();

        if (matchError || !match) throw new Error("Failed to create match: " + matchError?.message);
        console.log(`   ✅ Match Created: ${match.id} (Status: ${match.status})`);


        // --- STEP 2: ASSIGN SERVER (Simulate /api/match/start) ---
        console.log("\n2️⃣  Assigning Server (Calling API)...");

        const startRes = await fetch(`${BASE_URL}/api/match/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ matchId: match.id })
        });

        const startData = await startRes.json();
        if (!startRes.ok) throw new Error("API Error: " + JSON.stringify(startData));

        console.log(`   ✅ Server Assigned: ${startData.server.ip}:${startData.server.port}`);

        // Verify DB State
        const { data: serverCheck } = await supabase.from('game_servers').select('*').eq('current_match_id', match.id).single();
        if (serverCheck?.status !== 'BUSY') throw new Error("❌ Server DB status is NOT BUSY");
        console.log("   ✅ Database confirms Server is BUSY");


        // --- STEP 3: SIMULATE GAMEPLAY & WIN (Webhook) ---
        console.log("\n3️⃣  Simulating Win Condition (Webhook)...");

        // Payload matching your new logic (round_end, score >= 1)
        const webhookPayload = {
            event: 'round_end',
            matchid: match.contract_match_id,
            reason: 1, // "CT Win" or similar (not 16 "Game Commencing")
            team1: {
                score: 1, // WINNING_SCORE is 1 in your code
                players: [{ steamid: "STEAM_0:1:12345678", name: "WinnerBot" }]
            },
            team2: {
                score: 0,
                players: [{ steamid: "STEAM_0:1:87654321", name: "LoserBot" }]
            }
        };

        const webhookRes = await fetch(`${BASE_URL}/api/webhook?secret=${WEBHOOK_SECRET}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(webhookPayload)
        });

        const webhookData = await webhookRes.json();
        console.log(`   📡 Webhook Response: ${webhookRes.status}`, webhookData);


        // --- STEP 4: VERIFY RESULTS ---
        console.log("\n4️⃣  Verifying Final State...");
        await sleep(2000); // Give DB time to update

        // Check Match Status
        const { data: finalMatch } = await supabase.from('matches').select('*').eq('id', match.id).single();
        // Check Server Status
        const { data: finalServer } = await supabase.from('game_servers').select('*').eq('id', serverCheck.id).single();

        console.log(`   Match Status: ${finalMatch.status} (Expected: COMPLETE)`);
        console.log(`   Winner Addr:  ${finalMatch.winner_address} (Expected: ${match.player1_address})`);
        console.log(`   Server Status: ${finalServer.status} (Expected: FREE)`);

        if (finalMatch.status === 'COMPLETE' &&
            finalMatch.winner_address === match.player1_address &&
            finalServer.status === 'FREE') {
            console.log("\n✅✅✅ TEST PASSED: FULL CYCLE COMPLETE ✅✅✅");
        } else {
            console.error("\n❌❌❌ TEST FAILED: State mismatch ❌❌❌");
        }

    } catch (e: any) {
        console.error("\n💥 CRITICAL FAILURE:", e.message);
    }
}

main();
