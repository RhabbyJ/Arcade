import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getWalletFromSession } from '@/lib/sessionAuth';

/**
 * POST /api/match/start-deposit
 * 
 * Transitions match from LOBBY to DEPOSITING when both players are ready.
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

        // 3. Transition to DEPOSITING
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
