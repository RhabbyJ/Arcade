
import { NextResponse } from 'next/server';
import openid from 'openid';
import { cookies } from 'next/headers';

const STEAM_OPENID_URL = 'https://steamcommunity.com/openid';

export async function GET(req: Request): Promise<Response> {
    const { searchParams } = new URL(req.url);
    const walletAddress = searchParams.get('address');

    if (!walletAddress) {
        return NextResponse.json({ error: 'Wallet address required' }, { status: 400 });
    }

    const host = req.headers.get('host');
    const protocol = host?.includes('localhost') ? 'http' : 'https';
    const returnUrl = `${protocol}://${host}/api/auth/steam/callback`;

    const relyingParty = new openid.RelyingParty(
        returnUrl,
        `${protocol}://${host}`, // Realm
        true, // Use stateless verification
        false, // Strict mode
        [] // Extensions
    );

    return new Promise<Response>((resolve) => {
        relyingParty.authenticate(STEAM_OPENID_URL, false, (error, authUrl) => {
            if (error) {
                console.error('Steam Auth Error:', error);
                resolve(NextResponse.json({ error: 'Failed to initiate Steam auth' }, { status: 500 }));
            } else if (!authUrl) {
                resolve(NextResponse.json({ error: 'Authentication URL not found' }, { status: 500 }));
            } else {
                // Store the wallet address in a cookie to link it in the callback
                const cookieStore = cookies();
                const isSecure = protocol === 'https';
                cookieStore.set('linking_wallet', walletAddress, {
                    httpOnly: true,
                    secure: isSecure,
                    sameSite: 'lax',
                    maxAge: 60 * 10, // 10 minutes
                    path: '/'
                });

                resolve(NextResponse.redirect(authUrl));
            }
        });
    });
}
