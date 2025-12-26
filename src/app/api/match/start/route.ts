import { NextResponse } from 'next/server';

/**
 * POST /api/match/start
 * 
 * DEPRECATED: Server assignment is now handled by the Bot (payout_cron.js)
 * after both deposits are verified on-chain.
 */

export async function POST() {
    return NextResponse.json({
        error: "This endpoint is deprecated. Server assignment is now automatic after both deposits are verified.",
        status: "DEPRECATED"
    }, { status: 410 });
}
