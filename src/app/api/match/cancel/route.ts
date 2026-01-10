import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getWalletFromSession } from '@/lib/sessionAuth';

/**
 * POST /api/match/cancel
 * 
 * Cancel a match in LOBBY status (no deposits yet).
 * Requires: Authorization: Bearer <session_token>
 * Atomic operation - prevents race conditions.
 */
export async function POST(req: NextRequest) {
    try {
        const walletLower = await getWalletFromSession(req);

        if (!walletLower) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { matchId } = await req.json();

        if (!matchId) {
            return NextResponse.json({ error: "Missing matchId" }, { status: 400 });
        }

        // Atomic cancel: only cancel if LOBBY AND caller is a player
        const { data: match, error } = await supabaseAdmin
            .from('matches')
            .update({ status: 'CANCELLED' })
            .eq('id', matchId)
            .eq('status', 'LOBBY')
            .or(`player1_address.ilike.${walletLower},player2_address.ilike.${walletLower}`)
            .select('*')
            .maybeSingle();

        if (error) {
            console.error("[Cancel Match API] Error:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        if (!match) {
            return NextResponse.json({
                error: "Cannot cancel (not your match, or not in LOBBY)"
            }, { status: 400 });
        }

        console.log(`[Cancel Match API] Match ${matchId} cancelled by ${walletLower}`);

        return NextResponse.json({
            success: true,
            message: "Match cancelled"
        });

    } catch (e: any) {
        console.error("[Cancel Match API] Exception:", e);
        return NextResponse.json({ error: e.message || "Unknown error" }, { status: 500 });
    }
}
