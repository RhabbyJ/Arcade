import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/match/start
 * 
 * DEPRECATED: Server assignment is now handled by the Bot (payout_cron.js)
 * after both deposits are verified on-chain.
 * 
 * This endpoint is kept for backwards compatibility but will be removed.
 * The Bot's assignServers() function now handles:
 * 1. Finding a FREE server
 * 2. Marking it as BUSY
 * 3. Sending RCON reset commands
 * 4. Setting match status to LIVE
 */

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function POST(req: Request) {
    // Return deprecation notice
    return NextResponse.json({
        error: "This endpoint is deprecated. Server assignment is now automatic after both deposits are verified.",
        status: "DEPRECATED"
    }, { status: 410 }); // 410 Gone

    // Legacy code below (commented out for reference)
    /*
    try {
        const { matchId } = await req.json();
        if (!matchId) return NextResponse.json({ error: "Match ID required" }, { status: 400 });

        // Server assignment moved to Bot
        // See: scripts/payout_cron.js -> assignServers()

    } catch (error: any) {
        console.error("Error starting match:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
    */
}
