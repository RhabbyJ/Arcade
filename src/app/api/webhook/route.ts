
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: Request) {
    try {
        const payload = await req.json();
        console.log('Webhook received:', payload);

        if (payload.event === 'series_end') {
            const { team1, team2 } = payload;
            const t1Score = parseInt(team1.score);
            const t2Score = parseInt(team2.score);

            let winnerTeam = null;
            if (t1Score > t2Score) winnerTeam = 'team1';
            else if (t2Score > t1Score) winnerTeam = 'team2';
            else {
                console.log('Draw detected');
                return NextResponse.json({ received: true });
            }

            // Find the active match (LIVE)
            // For MVP, we assume there is only one LIVE match.
            const { data: match, error: fetchError } = await supabase
                .from('matches')
                .select('*')
                .eq('status', 'LIVE')
                .single();

            if (fetchError || !match) {
                console.error('No LIVE match found:', fetchError);
                return NextResponse.json({ error: 'No match found' }, { status: 404 });
            }

            const winnerAddress = winnerTeam === 'team1' ? match.player1_address : match.player2_address;

            // Update match status
            const { error: updateError } = await supabase
                .from('matches')
                .update({
                    status: 'COMPLETE',
                    winner_address: winnerAddress,
                    payout_status: 'PENDING', // Ready for the worker
                })
                .eq('id', match.id);

            if (updateError) {
                console.error('Failed to update match:', updateError);
                return NextResponse.json({ error: 'Update failed' }, { status: 500 });
            }

            console.log(`Match ${match.id} complete. Winner: ${winnerAddress}`);
        }

        return NextResponse.json({ received: true });
    } catch (error) {
        console.error('Webhook error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
