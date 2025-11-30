import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from .env.local
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!; // Ideally use SERVICE_ROLE key for backend, but Anon works if RLS allows
const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_ADDRESS!;
const PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY; // Needs to be added to .env.local
const RPC_URL = "https://sepolia.base.org";

const ESCROW_ABI = [
    "function payout(uint256 _matchId, address _winner) external",
    "function emergencyWithdraw(uint256 _matchId) external"
];

async function main() {
    console.log("--- STARTING PAYOUT WORKER ---");

    if (!PRIVATE_KEY) {
        console.error("ERROR: PAYOUT_PRIVATE_KEY not found in .env.local");
        process.exit(1);
    }

    // 1. Initialize Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // 2. Initialize Blockchain
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);

    // 3. Fetch Pending Payouts
    const { data: matches, error } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'COMPLETE')
        .eq('payout_status', 'PENDING');

    if (error) {
        console.error("DB Error:", error);
        return;
    }

    if (!matches || matches.length === 0) {
        console.log("No pending payouts found.");
        return;
    }

    console.log(`Found ${matches.length} matches to process.`);

    for (const match of matches) {
        console.log(`Processing Match ID: ${match.contract_match_id} | Winner: ${match.winner_address}`);

        try {
            // A. Mark as PROCESSING (Double-spend protection)
            await supabase
                .from('matches')
                .update({ payout_status: 'PROCESSING' })
                .eq('id', match.id);

            // B. Execute Payout
            const tx = await escrow.payout(match.contract_match_id, match.winner_address);
            console.log(`Tx Sent: ${tx.hash}`);
            await tx.wait();
            console.log("Tx Confirmed!");

            // C. Mark as PAID
            await supabase
                .from('matches')
                .update({ payout_status: 'PAID' })
                .eq('id', match.id);

        } catch (e: any) {
            console.error(`FAILED to pay match ${match.id}:`, e.message);

            // D. Revert to FAILED (or MANUAL_REVIEW)
            await supabase
                .from('matches')
                .update({ payout_status: 'FAILED' }) // Or 'PENDING' to retry? FAILED is safer.
                .eq('id', match.id);
        }
    }
}

main();
