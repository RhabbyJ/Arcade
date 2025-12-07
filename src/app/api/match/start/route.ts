import { NextResponse } from 'next/server';

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! // Use Service Role Key in production for better security
);

export async function POST(req: Request) {
    try {
        const { matchId } = await req.json();
        if (!matchId) return NextResponse.json({ error: "Match ID required" }, { status: 400 });

        // 1. Find a FREE server
        const { data: server, error: findError } = await supabase
            .from('game_servers')
            .select('*')
            .eq('status', 'FREE')
            .limit(1)
            .single();

        if (findError || !server) {
            console.error("No servers available:", findError);
            return NextResponse.json({ error: "All servers are busy. Please wait." }, { status: 503 });
        }

        console.log(`Assigning Server: ${server.name} (${server.ip}:${server.port}) to Match ${matchId}`);

        // 2. Mark Server as BUSY
        const { error: updateError } = await supabase
            .from('game_servers')
            .update({
                status: 'BUSY',
                current_match_id: matchId,
                last_heartbeat: new Date().toISOString()
            })
            .eq('id', server.id);

        if (updateError) {
            console.error("Failed to assign server:", updateError);
            return NextResponse.json({ error: "Failed to assign server" }, { status: 500 });
        }

        // 3. Reset the Server (RCON)
        const DATHOST_USER = process.env.DATHOST_USERNAME!;
        const DATHOST_PASS = process.env.DATHOST_PASSWORD!;

        const rconUrl = `https://dathost.net/api/0.1/game-servers/${server.dathost_id}/console`;
        const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');

        const response = await fetch(rconUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({ line: 'css_endmatch; mp_restartgame 1' })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`DatHost RCON Failed for ${server.dathost_id}:`, errorText);
            return NextResponse.json({ error: "Failed to reset server" }, { status: 500 });
        }

        // 4. Return Server Info to Frontend
        return NextResponse.json({
            success: true,
            server: {
                ip: server.ip,
                port: server.port,
                connect_command: `connect ${server.ip}:${server.port}; password lmaololz`
            }
        });

    } catch (error: any) {
        console.error("Error starting match:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
