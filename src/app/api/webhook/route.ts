
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

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
            const WINNING_SCORE = 2; // TODO: Set to 13 for production (MR24)

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
                if (match.player1_steam === winnerSteamId) {
                    winnerAddress = match.player1_address;
                } else if (match.player2_steam === winnerSteamId) {
                    winnerAddress = match.player2_address;
                } else {
                    console.error(`Winner Steam ID ${winnerSteamId} does not match any player in match ${match.id}`);
                    // Don't fail, just log. Manual review needed.
                }

                if (winnerAddress) {
                    const { error: updateError } = await supabase
                        .from('matches')
                        .update({
                            status: 'COMPLETE',
                            winner_address: winnerAddress,
                            payout_status: 'PENDING' // Triggers the payout cron
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
                            const kickCommands = ['kickall'];

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
