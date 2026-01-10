// DatHost API wrapper
const BASE = process.env.DATHOST_API_BASE ?? "https://dathost.net/api/0.1";

function basicAuth(): string {
    const user = process.env.DATHOST_USER || process.env.DATHOST_USERNAME;
    const pass = process.env.DATHOST_PASS || process.env.DATHOST_PASSWORD;
    if (!user || !pass) throw new Error("DATHOST credentials not configured");
    const token = Buffer.from(`${user}:${pass}`).toString("base64");
    return `Basic ${token}`;
}

export interface DatHostMatchParams {
    matchId: string;
    serverId: string;
    map: string;
    p1Steam64: string;
    p2Steam64: string;
    connectTimeSec?: number;
    warmupTimeSec?: number;
    beginCountdownSec?: number;
}

export async function startDatHostMatch(params: DatHostMatchParams) {
    const payload = {
        game_server_id: params.serverId,
        match_group_id: params.matchId,
        map: params.map,
        players: [
            { steam_id_64: params.p1Steam64, team: "team1", name: "Player 1" },
            { steam_id_64: params.p2Steam64, team: "team2", name: "Player 2" },
        ],
        settings: {
            connect_time: params.connectTimeSec ?? 60,
            warmup_time: params.warmupTimeSec ?? 15,
            match_begin_countdown: params.beginCountdownSec ?? 5,
        },
        webhooks: {
            event_url: `${process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL}/api/webhook/dathost`,
            authorization_header: `Bearer ${process.env.DATHOST_WEBHOOK_SECRET}`,
            enabled_events: ["match_started", "match_ended", "match_cancelled"],
        },
    };

    const res = await fetch(`${BASE}/cs2-matches`, {
        method: "POST",
        headers: {
            Authorization: basicAuth(),
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`DatHost start failed: ${res.status} ${text}`);
    }

    return await res.json();
}

export async function getDatHostMatch(dathostMatchId: string) {
    const res = await fetch(`${BASE}/cs2-matches/${dathostMatchId}`, {
        headers: { Authorization: basicAuth() },
    });

    if (res.status === 404) return { notFound: true as const };
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`DatHost get failed: ${res.status} ${text}`);
    }

    return await res.json();
}

export async function cancelDatHostMatch(dathostMatchId: string) {
    const res = await fetch(`${BASE}/cs2-matches/${dathostMatchId}`, {
        method: "DELETE",
        headers: { Authorization: basicAuth() },
    });

    if (!res.ok && res.status !== 404) {
        const text = await res.text();
        throw new Error(`DatHost cancel failed: ${res.status} ${text}`);
    }

    return { success: true };
}

// Test if CS2 Match API is available
export async function testDatHostMatchAPI(): Promise<boolean> {
    try {
        const res = await fetch(`${BASE}/cs2-matches?limit=1`, {
            headers: { Authorization: basicAuth() },
        });
        return res.ok;
    } catch {
        return false;
    }
}
