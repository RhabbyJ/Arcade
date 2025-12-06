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
            // Use matchzy_load_match_config to fully reset MatchZy state, or at least reload the config.
            // mp_restartgame 1 is not enough to clear MatchZy's "matchStarted" state.
            // We'll try reloading the practice config first, then the match config?
            // Actually, "matchzy_end_match" might be safer if it exists, but "exec live" or similar is standard.
            // Let's try forcing a full reload of the match plugin state.
            body: new URLSearchParams({ line: 'matchzy_load_match_config' })
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
