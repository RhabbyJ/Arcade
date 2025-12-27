import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/match/deposit
 * 
 * "Dumb" endpoint: Just saves the tx_hash to DB.
 * The Bot (payout_cron.js) will verify the hash on-chain.
 */

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function POST(req: NextRequest) {
    try {
        const { matchId, walletAddress, txHash } = await req.json();

        if (!matchId || !walletAddress || !txHash) {
            return NextResponse.json(
                { error: "Missing required fields: matchId, walletAddress, txHash" },
                { status: 400 }
            );
        }

        // 1. Fetch the match
        const { data: match, error: fetchError } = await supabase
            .from('matches')
            .select('*')
            .eq('id', matchId)
            .single();

        if (fetchError || !match) {
            return NextResponse.json({ error: "Match not found" }, { status: 404 });
        }

        // 2. Check if match is still accepting deposits
        if (!['LOBBY', 'DEPOSITING'].includes(match.status)) {
            return NextResponse.json({
                error: `Match is ${match.status}. Cannot accept deposits.`
            }, { status: 400 });
        }

        // 3. Determine which player is depositing
        const isPlayer1 = match.player1_address?.toLowerCase() === walletAddress.toLowerCase();
        const isPlayer2 = match.player2_address?.toLowerCase() === walletAddress.toLowerCase();

        if (!isPlayer1 && !isPlayer2) {
            return NextResponse.json({ error: "You are not a player in this match" }, { status: 403 });
        }

        // 3. Check if already deposited
        if (isPlayer1 && match.p1_tx_hash) {
            return NextResponse.json({ error: "Player 1 already submitted deposit" }, { status: 400 });
        }
        if (isPlayer2 && match.p2_tx_hash) {
            return NextResponse.json({ error: "Player 2 already submitted deposit" }, { status: 400 });
        }

        // 4. Save the tx_hash (Bot will verify on-chain)
        const updateField = isPlayer1 ? 'p1_tx_hash' : 'p2_tx_hash';

        const { error: updateError } = await supabase
            .from('matches')
            .update({
                [updateField]: txHash,
                status: 'DEPOSITING'
            })
            .eq('id', matchId);

        if (updateError) {
            console.error("Failed to save tx_hash:", updateError);
            return NextResponse.json({ error: "Failed to save transaction" }, { status: 500 });
        }

        console.log(`[Deposit API] Saved ${updateField} for match ${matchId}: ${txHash}`);

        return NextResponse.json({
            success: true,
            message: "Transaction hash saved. Bot will verify on-chain.",
            player: isPlayer1 ? 'player1' : 'player2',
            txHash
        });

    } catch (e: any) {
        console.error("[Deposit API] Error:", e);
        return NextResponse.json({ error: e.message || "Unknown error" }, { status: 500 });
    }
}
