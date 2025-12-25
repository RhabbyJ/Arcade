import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    const cookieStore = cookies();
    const steamId = cookieStore.get('steam_session_id')?.value;
    const steamName = cookieStore.get('steam_session_name')?.value;

    if (!steamId) {
        return NextResponse.json({ authenticated: false });
    }

    return NextResponse.json({
        authenticated: true,
        steamId,
        steamName
    });
}
