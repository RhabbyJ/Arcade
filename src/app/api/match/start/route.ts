import { NextResponse } from 'next/server';

export async function POST(req: Request) {
    const serverId = process.env.DATHOST_SERVER_ID;
    const username = process.env.DATHOST_USERNAME;
    const password = process.env.DATHOST_PASSWORD;

    if (!serverId || !username || !password) {
        return NextResponse.json({ error: 'Missing DatHost credentials' }, { status: 500 });
    }

    const auth = Buffer.from(`${username}:${password}`).toString('base64');

    try {
        console.log(`Resetting Server ${serverId}...`);

        const response = await fetch(`https://dathost.net/api/0.1/game-servers/${serverId}/console`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            // The Magic Sequence:
            // 1. exec MatchZy/warmup.cfg -> Tells MatchZy "Stop tracking, go to ready state"
            // 2. mp_restartgame 1 -> Tells CS2 "Restart the map clock"
            body: new URLSearchParams({ line: 'exec MatchZy/warmup.cfg; mp_restartgame 1' })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('DatHost Error:', errorText);
            throw new Error(`DatHost API Error: ${response.status} ${response.statusText}`);
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error('Reset failed:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
