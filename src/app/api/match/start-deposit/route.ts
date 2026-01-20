import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getWalletFromSession } from '@/lib/sessionAuth';
import { ethers, Wallet, Contract, JsonRpcProvider, parseUnits } from 'ethers';

// ESCROW V4 ABI - createMatch function
const ESCROW_V4_ABI = [
    "function createMatch(bytes32 matchId, address p1, address p2, uint256 stake) external",
    "function getMatch(bytes32 matchId) external view returns (address p1, address p2, uint256 stake, bool p1Deposited, bool p2Deposited, uint8 status, address winner)"
];

// Helper function
function numericToBytes32(num: number | string): string {
    const hex = BigInt(num).toString(16);
    return '0x' + hex.padStart(64, '0');
}

/**
 * POST /api/match/start-deposit
 * 
 * Transitions match from LOBBY to DEPOSITING when both players are ready.
 * ALSO creates the match on EscrowV4 contract (required for V4).
 * Only callable when both p1_ready and p2_ready are true.
 * 
 * Requires valid session
 */
export async function POST(req: NextRequest) {
    try {
        const wallet = await getWalletFromSession(req);

        if (!wallet) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { matchId } = await req.json();

        if (!matchId) {
            return NextResponse.json({ error: "Missing matchId" }, { status: 400 });
        }

        // 1. Fetch match
        const { data: match, error: fetchError } = await supabaseAdmin
            .from('matches')
            .select('*')
            .eq('id', matchId)
            .single();

        if (fetchError || !match) {
            return NextResponse.json({ error: "Match not found" }, { status: 404 });
        }

        // 2. Validation
        if (match.status !== 'LOBBY') {
            return NextResponse.json({ error: `Match is ${match.status}, cannot start deposit` }, { status: 400 });
        }

        // Verify caller is a player in this match
        const isPlayer1 = match.player1_address?.toLowerCase() === wallet;
        const isPlayer2 = match.player2_address?.toLowerCase() === wallet;

        if (!isPlayer1 && !isPlayer2) {
            return NextResponse.json({ error: "You are not a player in this match" }, { status: 403 });
        }

        // Both players must be ready
        if (!match.p1_ready || !match.p2_ready) {
            return NextResponse.json({ error: "Both players must be ready first" }, { status: 400 });
        }

        // ========================================================
        // 3. CREATE MATCH ON ESCROW V4 CONTRACT
        // ========================================================
        console.log("[Start Deposit API] >>> ENTERING BLOCKCHAIN SECTION <<<");

        const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS;
        const PAYOUT_PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY;
        const RPC_URL = process.env.POLYGON_RPC_URL || process.env.RPC_URL;

        if (!ESCROW_ADDRESS || !PAYOUT_PRIVATE_KEY || !RPC_URL) {
            console.error("[Start Deposit API] ❌ Missing env vars (ESCROW_ADDRESS, PAYOUT_PRIVATE_KEY, RPC_URL)");
            return NextResponse.json({ error: "Server configuration error - missing blockchain credentials" }, { status: 500 });
        }

        try {
            const provider = new JsonRpcProvider(RPC_URL);
            const botWallet = new Wallet(PAYOUT_PRIVATE_KEY, provider);
            const escrow = new Contract(ESCROW_ADDRESS, ESCROW_V4_ABI, botWallet);

            const matchIdBytes32 = numericToBytes32(match.contract_match_id);
            const stake = parseUnits("5", 18);

            console.log(`[Start Deposit API] createMatch(${matchIdBytes32}, ${match.player1_address}, ${match.player2_address}, 5 USDC)`);

            // Idempotency Check
            const existingMatch = await escrow.getMatch(matchIdBytes32);
            if (existingMatch.status !== BigInt(0)) {
                console.log(`[Start Deposit API] Match already exists (status ${existingMatch.status}). Skipping create.`);
            } else {
                console.log("[Start Deposit API] Sending TX...");
                const tx = await escrow.createMatch(
                    matchIdBytes32,
                    match.player1_address,
                    match.player2_address,
                    stake,
                    { gasLimit: 300000 }
                );
                console.log(`[Start Deposit API] TX Sent: ${tx.hash}. Waiting...`);
                await tx.wait();
                console.log(`[Start Deposit API] TX Confirmed!`);
            }
        } catch (chainError: any) {
            console.error("[Start Deposit API] ❌ Blockchain Error:", chainError);
            return NextResponse.json({
                error: "Failed to create on-chain match: " + (chainError.reason || chainError.message)
            }, { status: 500 });
        }

        console.log("[Start Deposit API] >>> BLOCKCHAIN SECTION COMPLETE <<<");

        // 4. Transition to DEPOSITING in database
        const now = new Date().toISOString();
        const { data, error: updateError } = await supabaseAdmin
            .from('matches')
            .update({
                status: 'DEPOSITING',
                deposit_started_at: now
            })
            .eq('id', matchId)
            .select()
            .single();

        if (updateError) {
            console.error("[Start Deposit API] Error:", updateError);
            return NextResponse.json({ error: updateError.message }, { status: 500 });
        }

        console.log(`[Start Deposit API] Match ${matchId} transitioned to DEPOSITING`);
        return NextResponse.json({ match: data });

    } catch (e: any) {
        console.error("[Start Deposit API] Exception:", e);
        return NextResponse.json({ error: e.message || "Unknown error" }, { status: 500 });
    }
}
