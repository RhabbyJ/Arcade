import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// GET: Check if current wallet has a valid session
export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get('wallet');

    if (!wallet) {
        return NextResponse.json({ authenticated: false, error: 'Wallet address required' });
    }

    const cookieStore = cookies();
    const sessionToken = cookieStore.get('session_token')?.value;

    if (!sessionToken) {
        return NextResponse.json({ authenticated: false });
    }

    // Validate session against database
    const { data: session, error } = await supabase
        .from('sessions')
        .select('*')
        .eq('session_token', sessionToken)
        .eq('wallet_address', wallet)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

    if (error || !session) {
        // Invalid or expired session - clear the cookie
        cookieStore.delete('session_token');
        return NextResponse.json({ authenticated: false });
    }

    return NextResponse.json({
        authenticated: true,
        steamId: session.steam_id,
        steamName: session.steam_name,
        steamAvatar: session.steam_avatar
    });
}

// DELETE: Logout - destroy session
export async function DELETE(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get('wallet');

    const cookieStore = cookies();
    const sessionToken = cookieStore.get('session_token')?.value;

    if (sessionToken) {
        // Delete session from database
        await supabase
            .from('sessions')
            .delete()
            .eq('session_token', sessionToken);

        // Clear the cookie
        cookieStore.delete('session_token');
    }

    return NextResponse.json({ success: true, message: 'Logged out' });
}
