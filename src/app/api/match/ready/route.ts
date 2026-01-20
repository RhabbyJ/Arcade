import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getWalletFromSession } from '@/lib/sessionAuth';

/**
 * POST /api/match/ready
 * 
 * Toggles the ready status for a player in a lobby.
 * Requires: Authorization: Bearer <session_token> (cookie or header)
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

        if (match.status !== 'LOBBY') {
            return NextResponse.json({ error: "Match is not in LOBBY state" }, { status: 400 });
        }

        // 2. Determine player and update ready status
        const isPlayer1 = match.player1_address?.toLowerCase() === wallet;
        const isPlayer2 = match.player2_address?.toLowerCase() === wallet;

        if (!isPlayer1 && !isPlayer2) {
            return NextResponse.json({ error: "You are not a player in this match" }, { status: 403 });
        }

        const updateCol = isPlayer1 ? 'p1_ready' : 'p2_ready';

        // Prepare update
        const updates: any = { [updateCol]: true };

        // Check if OTHER player is already ready -> Transition to DEPOSITING
        const otherPlayerReady = isPlayer1 ? match.p2_ready : match.p1_ready;

        if (otherPlayerReady) {
            console.log(`[Ready API] Both players ready! Waiting for Host to trigger Start Deposit...`);
            // NOTE: We do NOT transition to 'DEPOSITING' here anymore.
            // The Host's frontend will trigger /api/match/start-deposit to create the match on-chain first.
        }

        // Toggle to TRUE (always set true when clicking Ready)
        const { data, error: updateError } = await supabaseAdmin
            .from('matches')
            .update(updates)
            .eq('id', matchId)
            .select()
            .single();

        if (updateError) {
            console.error("[Ready API] Error:", updateError);
            return NextResponse.json({ error: updateError.message }, { status: 500 });
        }

        console.log(`[Ready API] Player ${wallet} (${updateCol}) ready for match ${matchId}`);
        return NextResponse.json({ match: data });

    } catch (e: any) {
        console.error("[Ready API] Exception:", e);
        return NextResponse.json({ error: e.message || "Unknown error" }, { status: 500 });
    }
}
