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

// 2. Parse Arguments
// Usage: node scripts/simulate_webhook.js [MATCH_ID] [TARGET_HOST]
const matchId = process.argv[2] || "12345";
const targetHost = process.argv[3] || "http://localhost:3000";

// Ensure targetHost doesn't have trailing slash
const baseUrl = targetHost.replace(/\/$/, "");
const webhookUrl = `${baseUrl}/api/webhook?secret=${secret}`;

// 3. Mock Payload
const payload = {
    event: "series_end",
    matchid: matchId,
    team1: { name: "Player 1", score: "16" },
    team2: { name: "Player 2", score: "5" },
    winner: { side: "team1" }
};

console.log(`\n📡 Sending Mock Webhook...`);
console.log(`   Target: ${webhookUrl}`);
console.log(`   Match:  ${matchId}`);
console.log(`   Result: Player 1 wins (16-5)\n`);

// 4. Send Request
fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
})
    .then(async (res) => {
        const text = await res.text();
        console.log(`Response Status: ${res.status}`);
        console.log(`Response Body:   ${text}`);

        if (res.ok) console.log("\n✅ Webhook delivered successfully!");
        else console.log("\n❌ Webhook failed.");
    })
    .catch(err => {
        console.error("\n❌ Network Error:", err.message);
    });
