import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function POST(req: NextRequest) {
    const cookieStore = cookies();
    const sessionToken = cookieStore.get('session_token')?.value;

    if (sessionToken) {
        // Delete session from database
        await supabaseAdmin
            .from('sessions')
            .delete()
            .eq('session_token', sessionToken);
    }

    // Clear the cookie
    cookieStore.delete('session_token');

    // Redirect to home
    const host = req.headers.get('host');
    const protocol = host?.includes('localhost') ? 'http' : 'https';

    return NextResponse.redirect(`${protocol}://${host}/`);
}

// Also support GET for simple logout links
export async function GET(req: NextRequest) {
    return POST(req);
}
