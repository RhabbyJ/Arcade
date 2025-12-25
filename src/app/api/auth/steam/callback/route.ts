
import { NextResponse } from 'next/server';
import openid from 'openid';
import { cookies } from 'next/headers';
import { supabase } from '@/lib/supabase';

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

            // Extract SteamID64 from claimed_id (e.g., https://steamcommunity.com/openid/id/76561198...)
            const steamId = result.claimedIdentifier?.split('/').pop();
            const cookieStore = cookies();
            const walletAddress = cookieStore.get('linking_wallet')?.value;

            if (!steamId || !walletAddress) {
                console.error('Missing SteamID or Wallet Address:', { steamId, walletAddress });
                resolve(NextResponse.redirect(`${protocol}://${host}/?error=missing_data`));
                return;
            }

            try {
                // Optional: Fetch Steam Profiler Data (Name/Avatar) if STEAM_API_KEY exists
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

                // Link in Database via Supabase RPC
                const { error: linkError } = await supabase.rpc('link_steam_account', {
                    p_wallet_address: walletAddress,
                    p_steam_id: steamId,
                    p_steam_name: steamName,
                    p_steam_avatar: steamAvatar
                });

                if (linkError) {
                    if (linkError.message?.includes('already linked to another wallet')) {
                        return resolve(NextResponse.redirect(`${protocol}://${host}/?error=steam_already_linked`));
                    }
                    throw linkError;
                }

                // Clear the linking cookie
                cookieStore.delete('linking_wallet');

                // Set SESSION cookies (Persistent login state for the browser)
                const oneDay = 24 * 60 * 60 * 1000;
                cookieStore.set('steam_session_id', steamId, { secure: true, httpOnly: true, sameSite: 'lax', maxAge: oneDay });
                cookieStore.set('steam_session_name', steamName || 'Steam User', { secure: true, httpOnly: false, sameSite: 'lax', maxAge: oneDay });

                resolve(NextResponse.redirect(`${protocol}://${host}/?success=steam_linked`));
            });
    });
}
