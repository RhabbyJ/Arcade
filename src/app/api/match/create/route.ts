import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getSessionData } from '@/lib/sessionAuth';

/**
 * POST /api/match/create
 * 
 * Creates a new match lobby.
 * Requires valid session (httpOnly cookie or Authorization header)
 */
export async function POST(req: NextRequest) {
    try {
        const sessionData = await getSessionData(req);

        if (!sessionData) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { wallet, steamId } = sessionData;

        if (!steamId) {
            return NextResponse.json({ error: "Link Steam Account First!" }, { status: 400 });
        }

        // DUPLICATE PREVENTION: Check if user already has an active match
        const { data: existingMatch } = await supabaseAdmin
            .from('matches')
            .select('*')
            .or(`player1_address.ilike.${wallet},player2_address.ilike.${wallet}`)
            .in('status', ['LOBBY', 'DEPOSITING', 'PENDING', 'LIVE', 'DATHOST_BOOTING', 'STARTING_MATCH'])
            .limit(1)
            .maybeSingle();

        if (existingMatch) {
            return NextResponse.json({
                error: `You already have an active match! (ID: ${existingMatch.contract_match_id})`,
                existingMatch
            }, { status: 400 });
        }

        const numericMatchId = Date.now();

        // Insert new match - server validates caller is the player1
        const { data, error } = await supabaseAdmin
            .from('matches')
            .insert([{
                player1_address: wallet,
                player1_steam: steamId,
                player2_address: '0x0000000000000000000000000000000000000000',
                status: 'LOBBY',
                contract_match_id: numericMatchId,
                payout_status: 'PENDING'
            }])
            .select()
            .single();

        if (error) {
            console.error("[Create Match API] Error:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        console.log(`[Create Match API] Match created: ${data.id} by ${wallet}`);
        return NextResponse.json({ match: data });

    } catch (e: any) {
        console.error("[Create Match API] Exception:", e);
        return NextResponse.json({ error: e.message || "Unknown error" }, { status: 500 });
    }
}
