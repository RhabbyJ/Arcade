import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

// This endpoint is DEPRECATED - use /api/auth/sessions instead
// Kept for backwards compatibility during migration
export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get('wallet');

    const cookieStore = cookies();
    const sessionToken = cookieStore.get('session_token')?.value;

    if (!sessionToken) {
        return NextResponse.json({ authenticated: false });
    }

    // Build query - if wallet is provided, validate against it
    let query = supabaseAdmin
        .from('sessions')
        .select('*')
        .eq('session_token', sessionToken)
        .gt('expires_at', new Date().toISOString());

    if (wallet) {
        query = query.eq('wallet_address', wallet);
    }

    const { data: session, error } = await query.maybeSingle();

    if (error || !session) {
        return NextResponse.json({ authenticated: false });
    }

    return NextResponse.json({
        authenticated: true,
        steamId: session.steam_id,
        steamName: session.steam_name,
        steamAvatar: session.steam_avatar,
        walletAddress: session.wallet_address
    });
}
