import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * POST /api/match/cancel
 * 
 * Cancel a match in LOBBY status (no deposits yet).
 * Server-side operation to bypass RLS.
 */
export async function POST(req: NextRequest) {
    try {
        const { matchId, walletAddress } = await req.json();

        if (!matchId || !walletAddress) {
            return NextResponse.json(
                { error: "Missing required fields: matchId, walletAddress" },
                { status: 400 }
            );
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

        // 2. Check caller is a player
        const isPlayer1 = match.player1_address?.toLowerCase() === walletAddress.toLowerCase();
        const isPlayer2 = match.player2_address?.toLowerCase() === walletAddress.toLowerCase();

        if (!isPlayer1 && !isPlayer2) {
            return NextResponse.json({ error: "You are not a player in this match" }, { status: 403 });
        }

        // 3. Only allow cancel in LOBBY status (no deposits)
        if (match.status !== 'LOBBY') {
            return NextResponse.json({
                error: `Cannot cancel match in ${match.status} status. Use refund endpoint if deposits were made.`
            }, { status: 400 });
        }

        // 4. Cancel the match
        const { error: updateError } = await supabaseAdmin
            .from('matches')
            .update({ status: 'CANCELLED' })
            .eq('id', matchId);

        if (updateError) {
            console.error("[Cancel Match API] Error:", updateError);
            return NextResponse.json({ error: "Failed to cancel match" }, { status: 500 });
        }

        console.log(`[Cancel Match API] Match ${matchId} cancelled by ${walletAddress}`);

        return NextResponse.json({
            success: true,
            message: "Match cancelled"
        });

    } catch (e: any) {
        console.error("[Cancel Match API] Exception:", e);
        return NextResponse.json({ error: e.message || "Unknown error" }, { status: 500 });
    }
}
