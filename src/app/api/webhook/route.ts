
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { ethers } from 'ethers';

const ESCROW_ABI = [
    "function payout(uint256 _matchId, address _winner) external"
];

export async function POST(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const secret = searchParams.get('secret');

        // 1. Security Check
        if (secret !== process.env.WEBHOOK_SECRET) {
            console.error('Unauthorized webhook attempt');
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const payload = await req.json();
        console.log('Webhook received:', payload);

        // HANDLE ROUND_END (Check for Win Condition)
        // We use round_end because series_end payload often lacks player data (empty players array).
        if (payload.event === 'round_end') {
            const { matchid, team1, team2 } = payload;
            const WINNING_SCORE = 1; // Updated to 1 for testing (since mp_maxrounds is 1)

            // Ignore "Game Commencing" (16) or other non-result reasons
            // Also ignore if players array is empty (MatchZy bug/timing issue)
            if (payload.reason === 16 || !team1.players?.length || !team2.players?.length) {
                console.log(`Ignoring round_end (Reason: ${payload.reason}, Players: ${team1.players?.length}/${team2.players?.length})`);
                return NextResponse.json({ received: true, status: 'ignored' });
            }

            let winnerTeam = null;
            let winnerSteamId = null;

            // Check if anyone reached the winning score
            if (team1.score >= WINNING_SCORE) {
                winnerTeam = 'team1';
                // @ts-ignore
                winnerSteamId = team1.players[0]?.steamid;
            } else if (team2.score >= WINNING_SCORE) {
                winnerTeam = 'team2';
                // @ts-ignore
                winnerSteamId = team2.players[0]?.steamid;
            }

            if (winnerTeam && winnerSteamId) {
                console.log(`Match ${matchid} finished via round_end. Winner: ${winnerTeam} (${winnerSteamId})`);

                // Find the LIVE match
                const { data: match, error: fetchError } = await supabase
                    .from('matches')
                    .select('*')
                    .eq('status', 'LIVE')
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (fetchError) {
                    console.error('Database error fetching match:', fetchError);
                    return NextResponse.json({ error: 'Database error' }, { status: 500 });
                }

                if (!match) {
                    console.log('No LIVE match found. It might have already been processed.');
                    return NextResponse.json({ received: true, status: 'no_live_match' });
                }

                let winnerAddress = null;
                // Trim whitespace just in case
                const cleanWinnerSteamId = winnerSteamId.trim();
                const cleanP1Steam = match.player1_steam?.trim();
                const cleanP2Steam = match.player2_steam?.trim();

                if (cleanP1Steam === cleanWinnerSteamId) {
                    winnerAddress = match.player1_address;
                } else if (cleanP2Steam === cleanWinnerSteamId) {
                    winnerAddress = match.player2_address;
                } else {
                    console.error(`MISMATCH: Winner Steam ID ${cleanWinnerSteamId} does not match:`);
                    console.error(`- Player 1: ${cleanP1Steam}`);
                    console.error(`- Player 2: ${cleanP2Steam}`);
                    console.error(`- Match ID: ${match.id}`);
                    // Don't fail, just log. Manual review needed.
                }

                if (winnerAddress) {
                    let payoutStatus = 'PENDING';

                    // AUTOMATIC PAYOUT REMOVED - MOVED TO WORKER SCRIPT
                    // Reason: Vercel timeouts can cause double-spends.
                    // The webhook now only marks the match as COMPLETE.
                    // The 'payout_cron.ts' script will pick this up and handle the blockchain TX safely.
                    console.log('Match complete. Payout queued for worker script.');

                    const { error: updateError } = await supabase
                        .from('matches')
                        .update({
                            status: 'COMPLETE',
                            winner_address: winnerAddress,
                            payout_status: payoutStatus
                        })
                        .eq('id', match.id);

                    if (updateError) {
                        console.error('Failed to update match:', updateError);
                        return NextResponse.json({ error: 'Update failed' }, { status: 500 });
                    }
                    console.log(`Match ${match.id} marked COMPLETE. Winner: ${winnerAddress}`);

                    // Trigger Auto-Kick
                    try {
                        const serverId = process.env.DATHOST_SERVER_ID;
                        const username = process.env.DATHOST_USERNAME;
                        const password = process.env.DATHOST_PASSWORD;

                        if (serverId && username && password) {
                            const auth = Buffer.from(`${username}:${password}`).toString('base64');

                            // Send "kickall" and individual kicks to ensure removal
                            // ALSO send "css_endmatch" to force MatchZy to reset the match state.
                            // "exec MatchZy/warmup.cfg" only reloads config, it doesn't stop the match logic.
                            const kickCommands = ['kickall', 'css_endmatch'];

                            // Add individual kicks for robustness
                            if (team1?.players) {
                                // @ts-ignore
                                team1.players.forEach(p => kickCommands.push(`kick "${p.name}"`));
                            }
                            if (team2?.players) {
                                // @ts-ignore
                                team2.players.forEach(p => kickCommands.push(`kick "${p.name}"`));
                            }

                            // Execute all kick commands
                            for (const cmd of kickCommands) {
                                await fetch(`https://dathost.net/api/0.1/game-servers/${serverId}/console`, {
                                    method: 'POST',
                                    headers: {
                                        'Authorization': `Basic ${auth}`,
                                        'Content-Type': 'application/x-www-form-urlencoded'
                                    },
                                    body: new URLSearchParams({ line: cmd })
                                });
                            }
                            console.log(`Sent kick commands: ${kickCommands.join(', ')}`);
                        }
                    } catch (e) {
                        console.error('Auto-kick failed:', e);
                    }
                }
            }

            return NextResponse.json({ received: true });
        }

        // HANDLE SERIES_END (Backup / Logging)
        if (payload.event === 'series_end') {
            console.log('Series End received (handled via round_end).');
            return NextResponse.json({ received: true });
        }

        return NextResponse.json({ received: true });
    } catch (error) {
        console.error('Webhook error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
