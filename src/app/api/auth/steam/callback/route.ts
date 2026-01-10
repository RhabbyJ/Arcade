import { NextResponse } from 'next/server';
import openid from 'openid';
import { cookies } from 'next/headers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { randomBytes } from 'crypto';

export async function GET(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const host = req.headers.get('host');
    const protocol = host?.includes('localhost') ? 'http' : 'https';
    const returnUrl = `${protocol}://${host}/api/auth/steam/callback`;

    const relyingParty = new openid.RelyingParty(
        returnUrl,
        `${protocol}://${host}`,
        true,
        false,
        []
    );

    return new Promise<Response>((resolve) => {
        relyingParty.verifyAssertion(req.url, async (error, result) => {
            if (error || !result || !result.authenticated) {
                console.error('Steam Verification Failed:', error);
                resolve(NextResponse.redirect(`${protocol}://${host}/?error=steam_failed`));
                return;
            }

            // Extract SteamID64 from claimed_id
            const steamId = result.claimedIdentifier?.split('/').pop();
            const cookieStore = cookies();
            const walletAddress = cookieStore.get('linking_wallet')?.value;

            if (!steamId || !walletAddress) {
                console.error('Missing SteamID or Wallet Address:', { steamId, walletAddress });
                resolve(NextResponse.redirect(`${protocol}://${host}/?error=missing_data`));
                return;
            }

            try {
                // 1. Fetch Steam Profile Data
                let steamName = null;
                let steamAvatar = null;
                const STEAM_API_KEY = process.env.STEAM_API_KEY;

                if (STEAM_API_KEY) {
                    const response = await fetch(
                        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`
                    );
                    const data = await response.json();
                    const player = data.response.players[0];
                    if (player) {
                        steamName = player.personaname;
                        steamAvatar = player.avatarfull;
                    }
                }

                // 2. Generate secure session token
                const sessionToken = randomBytes(32).toString('hex');

                // 3. Delete any existing sessions for this wallet (single session per wallet)
                await supabaseAdmin
                    .from('sessions')
                    .delete()
                    .eq('wallet_address', walletAddress);

                // 4. Create new session in database
                const { error: sessionError } = await supabaseAdmin
                    .from('sessions')
                    .insert({
                        wallet_address: walletAddress,
                        steam_id: steamId,
                        steam_name: steamName,
                        steam_avatar: steamAvatar,
                        session_token: sessionToken,
                        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
                    });

                if (sessionError) {
                    console.error('Session Creation Failed:', sessionError);
                    throw sessionError;
                }

                // 5. Soft-update user's preferred Steam (optional, for profile display)
                await supabaseAdmin.rpc('link_steam_account', {
                    p_wallet_address: walletAddress,
                    p_steam_id: steamId,
                    p_steam_name: steamName,
                    p_steam_avatar: steamAvatar
                });

                // 6. Clear the linking cookie and set the session token cookie
                cookieStore.delete('linking_wallet');

                const isSecure = protocol === 'https';
                cookieStore.set('session_token', sessionToken, {
                    httpOnly: true,
                    secure: isSecure,
                    sameSite: 'lax',
                    maxAge: 24 * 60 * 60, // 24 hours in seconds
                    path: '/'
                });

                // NEW: Check for returnTo cookie and redirect there
                const returnTo = cookieStore.get('steam_return_to')?.value;
                cookieStore.delete('steam_return_to'); // Clean up

                if (returnTo) {
                    // Validate returnTo is a relative URL or same origin (security)
                    const cleanUrl = returnTo.startsWith('/') ? `${protocol}://${host}${returnTo}` : returnTo;
                    if (cleanUrl.startsWith(`${protocol}://${host}`)) {
                        resolve(NextResponse.redirect(cleanUrl));
                        return;
                    }
                }

                resolve(NextResponse.redirect(`${protocol}://${host}/?success=logged_in`));
            } catch (err) {
                console.error('Session Creation Error:', err);
                resolve(NextResponse.redirect(`${protocol}://${host}/?error=session_failed`));
            }
        });
    });
}
