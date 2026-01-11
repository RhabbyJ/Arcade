import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getSessionData } from '@/lib/sessionAuth';

/**
 * POST /api/match/join
 * 
 * Joins an existing match lobby as player 2.
 * Requires valid session (httpOnly cookie or Authorization header)
 */
export async function POST(req: NextRequest) {
    try {
        const sessionData = await getSessionData(req);

        if (!sessionData) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { wallet, steamId } = sessionData;
        const { matchId } = await req.json(); // This is the contract_match_id from the invite link

        if (!matchId) {
            return NextResponse.json({ error: "Missing matchId" }, { status: 400 });
        }

        if (!steamId) {
            return NextResponse.json({ error: "Link Steam Account First!" }, { status: 400 });
        }

        // 1. Find the match by contract_match_id
        const { data: existingMatch, error: fetchError } = await supabaseAdmin
            .from('matches')
            .select('*')
            .eq('contract_match_id', matchId)
            .single();

        if (fetchError || !existingMatch) {
            return NextResponse.json({ error: "Match not found!" }, { status: 404 });
        }

        // 2. Validation
        if (existingMatch.status !== 'LOBBY') {
            return NextResponse.json({ error: "Match is not accepting players" }, { status: 400 });
        }

        if (existingMatch.player1_address?.toLowerCase() === wallet) {
            return NextResponse.json({ error: "You are already the host of this match!" }, { status: 400 });
        }

        if (existingMatch.player2_address && existingMatch.player2_address !== '0x0000000000000000000000000000000000000000') {
            return NextResponse.json({ error: "Match is full!" }, { status: 400 });
        }

        // 3. Join the match - set player2 and start ready timer
        const joinTime = new Date().toISOString();
        const { data, error } = await supabaseAdmin
            .from('matches')
            .update({
                player2_address: wallet,
                player2_steam: steamId,
                ready_started_at: joinTime
            })
            .eq('id', existingMatch.id)
            .select()
            .single();

        if (error) {
            console.error("[Join Match API] Error:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        console.log(`[Join Match API] ${wallet} joined match ${existingMatch.id}`);
        return NextResponse.json({ match: data });

    } catch (e: any) {
        console.error("[Join Match API] Exception:", e);
        return NextResponse.json({ error: e.message || "Unknown error" }, { status: 500 });
    }
}
