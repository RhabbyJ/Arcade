import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import { uuidToBytes32, numericToBytes32, ESCROW_ABI } from '@/lib/abi';

// Service Role needed to verify match status reliably
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_ADDRESS!;
const PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY!;
const RPC_URL = "https://sepolia.base.org";

export async function POST(req: NextRequest) {
    try {
        const { matchId, walletAddress } = await req.json();

        if (!matchId || !walletAddress) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        // 1. Fetch Match Data
        const { data: match, error: fetchError } = await supabase
            .from('matches')
            .select('*')
            .eq('id', matchId)
            .single();

        if (fetchError || !match) {
            return NextResponse.json({ error: "Match not found" }, { status: 404 });
        }

        // 2. Validate Refund Rules
        // Rule A: Must be P1 requesting (or admin)
        if (match.player1_address !== walletAddress) {
            return NextResponse.json({ error: "Only the match creator can cancel" }, { status: 403 });
        }

        // Rule B: Match must be in LOBBY or DEPOSITING state (before P2 joins/deposits)
        // If P2 has joined/deposited, it's a dispute, not a simple refund.
        // Actually, contract checks if P2 == address(0). 
        // If contract says P2 is 0x0, then we can refund.
        // But our DB might say 'DEPOSITING' even if P2 hasn't hit the contract yet.
        // Safer to rely on DB status mostly, but contract acts as final source of truth.
        if (match.status !== 'LOBBY' && match.status !== 'DEPOSITING') {
            return NextResponse.json({ error: "Cannot cancel match in current status" }, { status: 400 });
        }

        // 3. Prepare Blockchain Transaction
        if (!PRIVATE_KEY) {
            console.error("Missing PAYOUT_PRIVATE_KEY");
            return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
        }

        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);

        // Convert ID: Uses numeric contract_match_id or UUID?
        // Note: EscrowV2 now uses bytes32.
        // If we stored numeric ID in DB (contract_match_id), used that.
        // If we switch to UUIDs in V2, we use match.id.
        // Let's assume we are using numeric ID for now as per `payout_cron.ts`
        const matchIdBytes32 = numericToBytes32(match.contract_match_id);

        console.log(`Processing Refund for Match: ${match.contract_match_id} (${matchIdBytes32})`);

        // 4. Verify ON-CHAIN status (Double check P2 hasn't joined 1ms ago)
        try {
            const contractMatch = await escrow.getMatch(matchIdBytes32);
            // Contract returns: [player1, player2, pot, isComplete, isActive]
            const player2 = contractMatch[1];
            const pot = contractMatch[2];
            const isActive = contractMatch[4];

            console.log(`On-chain status: P2=${player2}, Pot=${pot}, Active=${isActive}`);

            // If no pot, nothing to refund on-chain
            if (pot.toString() === '0') {
                console.log("No on-chain deposit found. Skipping blockchain refund.");
                // Just update DB and return success
                await supabase
                    .from('matches')
                    .update({ status: 'CANCELLED' })
                    .eq('id', matchId);
                return NextResponse.json({ success: true, message: "Match cancelled (no deposit to refund)" });
            }

            if (!isActive) {
                return NextResponse.json({ error: "Match already inactive on-chain" }, { status: 400 });
            }
            if (player2 !== ethers.ZeroAddress) {
                return NextResponse.json({ error: "Player 2 has already joined! Cannot simple-cancel." }, { status: 400 });
            }
        } catch (chainError) {
            console.error("Chain verify failed:", chainError);
            return NextResponse.json({ error: "Failed to verify on-chain status" }, { status: 500 });
        }

        // 5. Execute Refund via Bot
        const tx = await escrow.refundMatch(matchIdBytes32, walletAddress);
        console.log(`Refund Tx Sent: ${tx.hash}`);
        await tx.wait();

        // 6. Update DB
        await supabase
            .from('matches')
            .update({ status: 'CANCELLED', payout_status: 'REFUNDED' })
            .eq('id', matchId);

        // 7. Release Server (if assigned)
        await supabase
            .from('game_servers')
            .update({ status: 'AVAILABLE', current_match_id: null })
            .eq('current_match_id', matchId);

        return NextResponse.json({ success: true, txHash: tx.hash });

    } catch (e: any) {
        console.error("Refund failed:", e);
        return NextResponse.json({ error: e.message || "Refund failed" }, { status: 500 });
    }
}
