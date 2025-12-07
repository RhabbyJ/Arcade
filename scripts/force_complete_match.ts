import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
    console.log("--- FORCING MATCH COMPLETION ---");

    // 1. Get the latest match (regardless of status)
    const { data: match, error } = await supabase
        .from('matches')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    if (error || !match) {
        console.error("Error fetching match:", error);
        return;
    }

    console.log(`Found Match ID: ${match.id} (Contract ID: ${match.contract_match_id})`);
    console.log(`Current Status: ${match.status}`);
    console.log(`Player 1: ${match.player1_address}`);

    // 2. Force Update to COMPLETE + PENDING
    // We assume Player 1 is the winner for this test
    const { error: updateError } = await supabase
        .from('matches')
        .update({
            status: 'COMPLETE',
            winner_address: match.player1_address, // Force Player 1 win
            payout_status: 'PENDING'
        })
        .eq('id', match.id);

    if (updateError) {
        console.error("Update failed:", updateError);
    } else {
        console.log("✅ Match updated successfully!");
        console.log("Ready for payout_cron.ts");
    }
}

main();
