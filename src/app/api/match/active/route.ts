import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getWalletFromSession } from '@/lib/sessionAuth';

/**
 * GET /api/match/active
 * 
 * Returns the active match for the authenticated user.
 * Requires: Authorization: Bearer <session_token>
 */
export async function GET(req: NextRequest) {
    try {
        const walletLower = await getWalletFromSession(req);

        if (!walletLower) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { data, error } = await supabaseAdmin
            .from('matches')
            .select('*')
            .or(`player1_address.ilike.${walletLower},player2_address.ilike.${walletLower}`)
            .in('status', ['LOBBY', 'DEPOSITING', 'PENDING', 'LIVE', 'DATHOST_BOOTING', 'STARTING_MATCH'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error("[Active Match API] Error:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ match: data });
    } catch (e: any) {
        console.error("[Active Match API] Exception:", e);
        return NextResponse.json({ error: e.message || "Unknown error" }, { status: 500 });
    }
}
