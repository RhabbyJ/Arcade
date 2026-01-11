import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * GET /api/match/[id]/debug
 * 
 * Returns match details + recent match_events for debugging.
 * Protected by secret query param (not for production use).
 */
export async function GET(
    req: NextRequest,
    { params }: { params: { id: string } }
) {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get('secret');

    // Simple secret protection - use env var in production
    if (secret !== process.env.WEBHOOK_SECRET && secret !== 'debug123') {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const matchId = params.id;

    // 1. Fetch match
    const { data: match, error: matchError } = await supabaseAdmin
        .from('matches')
        .select('*')
        .eq('id', matchId)
        .single();

    if (matchError || !match) {
        // Try by contract_match_id
        const { data: matchByContract } = await supabaseAdmin
            .from('matches')
            .select('*')
            .eq('contract_match_id', matchId)
            .single();

        if (!matchByContract) {
            return NextResponse.json({ error: "Match not found" }, { status: 404 });
        }

        // Use this match
        const events = await getMatchEvents(matchByContract.id);
        const server = await getAssignedServer(matchByContract.id);

        return NextResponse.json({
            match: matchByContract,
            server,
            events,
            _debug: {
                timestamp: new Date().toISOString(),
                lookupBy: 'contract_match_id'
            }
        });
    }

    // 2. Fetch match_events
    const events = await getMatchEvents(match.id);

    // 3. Fetch assigned server
    const server = await getAssignedServer(match.id);

    return NextResponse.json({
        match,
        server,
        events,
        _debug: {
            timestamp: new Date().toISOString(),
            lookupBy: 'uuid'
        }
    });
}

async function getMatchEvents(matchId: string) {
    const { data } = await supabaseAdmin
        .from('match_events')
        .select('*')
        .eq('match_id', matchId)
        .order('created_at', { ascending: false })
        .limit(20);
    return data || [];
}

async function getAssignedServer(matchId: string) {
    const { data } = await supabaseAdmin
        .from('game_servers')
        .select('*')
        .eq('current_match_id', matchId)
        .maybeSingle();
    return data;
}
