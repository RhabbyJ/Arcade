const fs = require('fs');
const path = require('path');
const https = require('https');

// 1. Read .env.local manually
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');

const env = {};
envContent.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
        const key = match[1].trim();
        const value = match[2].trim().replace(/^["'](.*)["']$/, '$1'); // Remove quotes
        env[key] = value;
    }
});

const serverId = env.DATHOST_SERVER_ID;
const username = env.DATHOST_USERNAME;
const password = env.DATHOST_PASSWORD;

console.log("--- DATHOST CREDENTIALS CHECK ---");
console.log("Server ID:", serverId);
console.log("Username:", username);
console.log("Password:", password ? "***" + password.slice(-3) : "UNDEFINED");

if (!serverId || !username || !password) {
    console.error("ERROR: Missing credentials in .env.local");
    process.exit(1);
}

// 2. Make Request
const auth = Buffer.from(`${username}:${password}`).toString('base64');
const options = {
    hostname: 'dathost.net',
    path: `/api/0.1/game-servers/${serverId}/console`,
    method: 'POST',
    headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
    }
};

console.log(`\nSending Request to: https://dathost.net${options.path}`);

const req = https.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);

    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        console.log("RESPONSE:", data);
        if (res.statusCode === 200) {
            console.log("\nSUCCESS! Credentials are correct.");
        } else {
            console.log("\nFAILED. Please check your credentials.");
        }
    });
});

req.on('error', (e) => {
    console.error(`PROBLEM: ${e.message}`);
});

req.write('line=status'); // Simple command just to test auth
req.end();
