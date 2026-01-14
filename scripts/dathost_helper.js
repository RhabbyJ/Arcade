async function uploadDatHostConfig(gameServerId) {
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');

    // Quick Match Config
    const configContent = `
mp_maxrounds 2
mp_freezetime 3
mp_halftime 0
mp_overtime_enable 0
bot_quota 0
bot_kick
Say "Arcade Quick Match Config Loaded"
    `.trim();

    // Determine path. Usually cfg/sourcemod/.. or just cfg/
    // DatHost docs say "cfg/live_server.cfg" is executed when match goes live.
    const path = "cfg/live_server.cfg";

    // FormData implies multipart/form-data, but DatHost API for raw file upload usually accepts raw body or specific format.
    // Doc: POST /api/0.1/game-servers/{id}/files/{path}
    // Body: Raw file content

    const url = `https://dathost.net/api/0.1/game-servers/${gameServerId}/files/${encodeURIComponent(path)}`;

    console.log(`[DatHost] Uploading custom config to ${path}...`);

    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "text/plain" // or application/octet-stream
        },
        body: configContent
    });

    if (!res.ok) {
        const txt = await res.text();
        console.warn(`[DatHost] Config upload failed (Non-critical?): ${res.status} ${txt}`);
    } else {
        console.log(`[DatHost] Config uploaded successfully.`);
    }
}
