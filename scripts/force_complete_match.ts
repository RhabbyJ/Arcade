import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
    console.log("--- SIMULATING WEBHOOK WIN ---");

    // 1. Get the latest LIVE match
    const { data: match, error } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'LIVE')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    if (error || !match) {
        console.error("No LIVE match found:", error);
        return;
    }

    console.log(`Found LIVE Match: ${match.id}`);
    console.log(`P1 Steam: ${match.player1_steam}`);

    // 2. Call the Webhook
    // We use the deployed URL because the webhook logic is on Vercel
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) {
        console.error("Missing WEBHOOK_SECRET in .env.local");
        return;
    }
    const WEBHOOK_URL = `https://arcade-sable.vercel.app/api/webhook?secret=${secret}`;

    console.log(`Calling Webhook: ${WEBHOOK_URL}`);

    const payload = {
        event: 'round_end',
        match_id: 'simulated_match_id',
        reason: 'ct_win', // Assuming CT won
        team1: {
            score: 13, // Winning score
            players: [
                { steamid: match.player1_steam || '976', name: 'Player1' } // Use real SteamID from DB
            ]
        },
        team2: {
            score: 0,
            players: [
                { steamid: '00000', name: 'Bot' }
            ]
        }
    };

    const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    console.log(`Response: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`Body: ${text}`);
}

main();
