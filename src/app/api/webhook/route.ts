
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

        if (payload.event === 'series_end') {
            const { matchid, team1, team2 } = payload;
            const t1Score = parseInt(team1.score);
            const t2Score = parseInt(team2.score);

            let winnerTeam = null;
            let matchStatus = 'COMPLETE';
            let payoutStatus = 'PENDING';

            // 2. Determine Result
            if (t1Score > t2Score) {
                winnerTeam = 'team1';
            } else if (t2Score > t1Score) {
                winnerTeam = 'team2';
            } else {
                console.log(`Draw detected for match: ${matchid}`);
                matchStatus = 'DISPUTED';
                payoutStatus = 'MANUAL_REVIEW';
            }

            // 3. Concurrency Safe Lookup
            // We use the contract_match_id (which maps to DatHost matchid) to find the specific row
            const { data: match, error: fetchError } = await supabase
                .from('matches')
                .select('*')
                .eq('contract_match_id', matchid)
                .single();

            if (fetchError || !match) {
                console.error(`Match ${matchid} not found in DB:`, fetchError);
                return NextResponse.json({ error: 'Match not found' }, { status: 404 });
            }

            const winnerAddress = winnerTeam === 'team1' ? match.player1_address : (winnerTeam === 'team2' ? match.player2_address : null);

            // 4. Update State
            const { error: updateError } = await supabase
                .from('matches')
                .update({
                    status: matchStatus,
                    winner_address: winnerAddress,
                    payout_status: payoutStatus,
                })
                .eq('id', match.id);

            if (updateError) {
                console.error('Failed to update match:', updateError);
                return NextResponse.json({ error: 'Update failed' }, { status: 500 });
            }

            console.log(`Match ${match.id} processed. Status: ${matchStatus}`);

            // 5. Cleanup Server (Kick Players)
            try {
                const serverId = process.env.DATHOST_SERVER_ID;
                const username = process.env.DATHOST_USERNAME;
                const password = process.env.DATHOST_PASSWORD;

                if (serverId && username && password) {
                    console.log(`Cleaning up Server ${serverId}...`);
                    const auth = Buffer.from(`${username}:${password}`).toString('base64');

                    // Send "kickall" to remove players
                    await fetch(`https://dathost.net/api/0.1/game-servers/${serverId}/console`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Basic ${auth}`,
                            'Content-Type': 'application/x-www-form-urlencoded'
                        },
                        body: new URLSearchParams({ line: 'kickall' })
                    });
                    console.log('Server cleanup command sent.');
                }
            } catch (cleanupError) {
                console.error('Failed to cleanup server:', cleanupError);
                // Don't fail the webhook just because cleanup failed
            }
        }

        return NextResponse.json({ received: true });
    } catch (error) {
        console.error('Webhook error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
