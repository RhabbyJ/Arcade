import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getWalletFromSession } from '@/lib/sessionAuth';

/**
 * POST /api/match/leave
 * 
 * Allows a player to leave a LOBBY.
 * - If Host (player1): Cancels the match entirely
 * - If Guest (player2): Leaves the match (resets P2 fields)
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

        if (match.status !== 'LOBBY') {
            return NextResponse.json({ error: "Cannot leave match unless in LOBBY status" }, { status: 400 });
        }

        const isPlayer1 = match.player1_address?.toLowerCase() === wallet;
        const isPlayer2 = match.player2_address?.toLowerCase() === wallet;

        if (!isPlayer1 && !isPlayer2) {
            return NextResponse.json({ error: "You are not a player in this match" }, { status: 403 });
        }

        // 2. Handle based on role
        if (isPlayer1) {
            // Host cancels the entire match
            await supabaseAdmin
                .from('matches')
                .update({ status: 'CANCELLED' })
                .eq('id', matchId);

            console.log(`[Leave Match API] Host ${wallet} cancelled match ${matchId}`);
            return NextResponse.json({ action: 'cancelled', message: "Match cancelled by host" });
        } else {
            // Guest leaves - reset P2 fields and ready states
            await supabaseAdmin
                .from('matches')
                .update({
                    player2_address: null,
                    player2_steam: null,
                    p1_ready: false,
                    p2_ready: false,
                    ready_started_at: null
                })
                .eq('id', matchId);

            console.log(`[Leave Match API] Guest ${wallet} left match ${matchId}`);
            return NextResponse.json({ action: 'left', message: "Left the lobby" });
        }

    } catch (e: any) {
        console.error("[Leave Match API] Exception:", e);
        return NextResponse.json({ error: e.message || "Unknown error" }, { status: 500 });
    }
}
