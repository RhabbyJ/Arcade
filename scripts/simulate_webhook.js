const http = require('http');
const fs = require('fs');
const path = require('path');

// 1. Read .env.local for Secret
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const match = envContent.match(/WEBHOOK_SECRET=(.*)/);
const secret = match ? match[1].trim().replace(/^["'](.*)["']$/, '$1') : null;

if (!secret) {
    console.error("Error: WEBHOOK_SECRET not found in .env.local");
    process.exit(1);
}

// 2. Mock Payload (What MatchZy sends)
// We need a valid matchid from your Supabase DB to test this properly!
// For now, we'll use a placeholder, but you should update this.
const matchId = process.argv[2] || "12345"; // Pass match ID as argument

const payload = JSON.stringify({
    event: "series_end",
    matchid: matchId,
    team1: { name: "Player 1", score: "13" },
    team2: { name: "Player 2", score: "5" },
    winner: { side: "team1" }
});

// 3. Send Request
const options = {
    hostname: 'localhost',
    port: 3000,
    path: `/api/webhook?secret=${secret}`,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
    }
};

console.log(`Sending Mock Webhook for Match ID: ${matchId}...`);

const req = http.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
        console.log(`BODY: ${chunk}`);
    });
});

req.on('error', (e) => {
    console.error(`problem with request: ${e.message}`);
});

req.write(payload);
req.end();
