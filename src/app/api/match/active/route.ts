import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * GET /api/match/active?wallet=0x...
 * 
 * Returns the active match for a wallet address (if any).
 * Server-side query to bypass RLS.
 */
export async function GET(req: NextRequest) {
    try {
        const wallet = req.nextUrl.searchParams.get('wallet');

        if (!wallet) {
            return NextResponse.json({ error: "Missing wallet parameter" }, { status: 400 });
        }

        const walletLower = wallet.toLowerCase();

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
