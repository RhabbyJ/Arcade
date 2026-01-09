const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');

// Load env vars
const envPaths = [
    path.resolve(__dirname, '../.env.local'),
    path.resolve('/root/base-bot/.env'),
    path.resolve(process.cwd(), '.env.local')
];
for (const p of envPaths) {
    if (fs.existsSync(p)) {
        dotenv.config({ path: p });
        console.log(`Loaded env from: ${p}`);
        break;
    }
}

// Config
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_ADDRESS;
const PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY;
const RPC_URL = "https://sepolia.base.org";
const DATHOST_USER = process.env.DATHOST_USERNAME;
const DATHOST_PASS = process.env.DATHOST_PASSWORD;

const ESCROW_ABI = [
    "function distributeWinnings(bytes32 matchId, address winner) external",
    "function refundMatch(bytes32 matchId, address player) external",
    "function matches(bytes32) view returns (address player1, address player2, uint256 pot, bool isComplete, bool isActive)"
];

function numericToBytes32(num) {
    const hex = BigInt(num).toString(16);
    return '0x' + hex.padStart(64, '0');
}

// State
const warmupState = new Map();
const afkState = new Map();
const AFK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes to show up

// --- HELPERS ---

// Updated: Now returns the response text so we can parse it
async function sendRcon(dathostId, command) {
    if (!DATHOST_USER || !DATHOST_PASS) return null;
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');

    try {
        const response = await fetch(`https://dathost.net/api/0.1/game-servers/${dathostId}/console`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({ line: command })
        });
        // DatHost API returns the console output directly in the body
        return await response.text();
    } catch (e) {
        console.error("RCON Error:", e.message);
        return null;
    }
}

async function getRealPlayerCount(dathostId) {
    // We send 'status' and count the lines that look like human players
    const output = await sendRcon(dathostId, 'status');
    if (!output) return 0;

    // CS2 Status Output Regex for humans: 
    // Matches lines like: # 5 "Name" [U:1:12345] ...
    // Excludes GOTV/SourceTV/Bots usually
    const matches = output.match(/#\s+\d+\s+".*?"\s+\[U:\d+:\d+\]/g);
    return matches ? matches.length : 0;
}

// --- LOGIC ---

async function verifyDeposits(supabase, provider) {
    const { data: matches } = await supabase.from('matches').select('*').eq('status', 'DEPOSITING').or('p1_deposited.eq.false,p2_deposited.eq.false');
    if (!matches) return;
    for (const match of matches) {
        if (match.p1_tx_hash && !match.p1_deposited) {
            try {
                const tx = await provider.getTransactionReceipt(match.p1_tx_hash);
                if (tx && tx.status === 1) {
                    console.log(`[${new Date().toISOString()}] ✅ P1 Deposit VERIFIED: Match ${match.contract_match_id}`);
                    await supabase.from('matches').update({ p1_deposited: true }).eq('id', match.id);
                }
            } catch (e) { }
        }
        if (match.p2_tx_hash && !match.p2_deposited) {
            try {
                const tx = await provider.getTransactionReceipt(match.p2_tx_hash);
                if (tx && tx.status === 1) {
                    console.log(`[${new Date().toISOString()}] ✅ P2 Deposit VERIFIED: Match ${match.contract_match_id}`);
                    await supabase.from('matches').update({ p2_deposited: true }).eq('id', match.id);
                }
            } catch (e) { }
        }
    }
}

async function assignServers(supabase) {
    const { data: matches } = await supabase.from('matches').select('*').eq('status', 'DEPOSITING').eq('p1_deposited', true).eq('p2_deposited', true);
    if (!matches || matches.length === 0) return;
    const { data: servers } = await supabase.from('game_servers').select('*').eq('status', 'FREE').limit(matches.length);
    if (!servers || servers.length === 0) {
        console.log("⚠️ No free servers available.");
        return;
    }

    for (let i = 0; i < Math.min(matches.length, servers.length); i++) {
        const match = matches[i];
        const server = servers[i];
        console.log(`[${new Date().toISOString()}] 🎮 Assigning Server ${server.name} to Match ${match.contract_match_id}`);
        await supabase.from('game_servers').update({ status: 'BUSY', current_match_id: match.id }).eq('id', server.id);

        // Initial setup
        await sendRcon(server.dathost_id, 'get5_endmatch');
        await sendRcon(server.dathost_id, 'css_endmatch');
        await sendRcon(server.dathost_id, 'host_workshop_map 3344743064');

        // We rely on MatchZy's auto-exec configs now, but we exec warmup once to be safe
        await sendRcon(server.dathost_id, 'exec MatchZy/warmup.cfg');

        await supabase.from('matches').update({ status: 'LIVE', server_assigned_at: new Date().toISOString() }).eq('id', match.id);
        console.log(`[${new Date().toISOString()}] 🚀 Match ${match.contract_match_id} is LIVE! (60s Warmup)`);
    }
}

// *** THE NEW OBSERVER LOGIC - SOURCE OF TRUTH ***
async function checkAutoStart(supabase, escrow) {
    const now = Date.now();
    const { data: matches } = await supabase.from('matches').select('*').eq('status', 'LIVE').is('match_started_at', null);
    if (!matches) return;

    for (const match of matches) {
        if (match.server_assigned_at && now - new Date(match.server_assigned_at).getTime() < 10000) continue;
        const { data: server } = await supabase.from('game_servers').select('*').eq('current_match_id', match.id).single();
        if (!server) continue;

        // SOURCE OF TRUTH: Ask the server, don't trust the DB/Webhooks for this state
        const playerCount = await getRealPlayerCount(server.dathost_id);

        console.log(`   📊 Match ${match.contract_match_id}: ${playerCount} Players (Server Verified)`);

        // 1. SOMEONE LEFT / EMPTY
        if (playerCount < 2) {
            warmupState.delete(match.id); // Cancel any start timers

            if (!afkState.has(match.id)) {
                console.log(`   👤 Match ${match.contract_match_id}: Waiting for players. Starting AFK timer.`);
                afkState.set(match.id, { start: now });
            } else {
                const elapsed = now - afkState.get(match.id).start;
                const remaining = Math.max(0, AFK_TIMEOUT_MS - elapsed);

                if (remaining > 0 && remaining % 30000 < 5000) {
                    console.log(`   ⏳ Match ${match.contract_match_id}: ${Math.ceil(remaining / 1000)}s until AFK cancel`);
                }

                // If they are gone for > 2 mins, cancel match
                if (elapsed > AFK_TIMEOUT_MS) {
                    console.log(`[${new Date().toISOString()}] ⏰ Match ${match.contract_match_id}: AFK Timeout.`);
                    await sendRcon(server.dathost_id, 'say "Match Cancelled (AFK)"');
                    await sendRcon(server.dathost_id, 'css_endmatch');
                    await refundPlayer(supabase, escrow, match, match.player1_address);
                    await supabase.from('matches').update({ status: 'CANCELLED', payout_status: 'REFUND_PENDING' }).eq('id', match.id);
                    await supabase.from('game_servers').update({ status: 'FREE', current_match_id: null }).eq('id', server.id);
                    afkState.delete(match.id);
                }
            }
            continue;
        }

        // 2. BOTH CONNECTED
        if (playerCount >= 2) {
            if (afkState.has(match.id)) afkState.delete(match.id);

            // The server config (60s timer) is the boss. We just watch.
            if (!warmupState.has(match.id)) {
                console.log(`   ✅ Both Connected. Config timer should be running...`);
                warmupState.set(match.id, { start: now });
            } else {
                // Failsafe: If 75s pass and match hasn't started (e.g. config failed), force it.
                const elapsed = now - warmupState.get(match.id).start;
                if (elapsed > 75000) {
                    console.log(`[${new Date().toISOString()}] 🚦 Match ${match.contract_match_id}: Stuck in Warmup. FORCING START.`);
                    await sendRcon(server.dathost_id, 'css_start');
                    await supabase.from('matches').update({ match_started_at: new Date().toISOString() }).eq('id', match.id);
                    warmupState.delete(match.id);
                }
            }
        }
    }
}

async function checkForfeits(supabase) {
    const { data: matches } = await supabase.from('matches').select('*').eq('status', 'LIVE');
    if (!matches) return;
    const FORFEIT_TIMEOUT = 5 * 60 * 1000;
    const now = Date.now();
    for (const match of matches) {
        let winner = null;
        if (match.player1_disconnect_time && (now - new Date(match.player1_disconnect_time).getTime() > FORFEIT_TIMEOUT)) winner = match.player2_address;
        else if (match.player2_disconnect_time && (now - new Date(match.player2_disconnect_time).getTime() > FORFEIT_TIMEOUT)) winner = match.player1_address;
        if (winner) {
            console.log(`[${new Date().toISOString()}] 🚨 Match ${match.contract_match_id} Forfeit. Winner: ${winner.slice(0, 10)}...`);
            await supabase.from('matches').update({ status: 'COMPLETE', winner_address: winner, payout_status: 'PENDING' }).eq('id', match.id);
            await resetServer(supabase, match.id);
        }
    }
}

// PAYOUTS (With Audit Timestamps)
async function processPayouts(supabase, escrow) {
    const { data: matches } = await supabase.from('matches').select('*').eq('status', 'COMPLETE').eq('payout_status', 'PENDING');
    if (!matches || matches.length === 0) return;

    console.log(`\n💰 [${new Date().toISOString()}] Processing ${matches.length} payout(s)...`);

    for (const match of matches) {
        const now = new Date();
        const matchStarted = match.match_started_at ? new Date(match.match_started_at) : null;
        const matchCreated = new Date(match.created_at);

        const timeSinceStart = matchStarted ? Math.round((now - matchStarted) / 1000) : 'N/A';
        const timeSinceCreated = Math.round((now - matchCreated) / 1000);

        console.log(`\n   ┌─────────────────────────────────────────────────────`);
        console.log(`   │ 💰 PAYOUT: Match ${match.contract_match_id}`);
        console.log(`   │ ⏱️  Time Now:          ${now.toISOString()}`);
        console.log(`   │ 📅 Match Created:     ${match.created_at}`);
        console.log(`   │ 🎮 Match Started:     ${match.match_started_at || 'N/A'}`);
        console.log(`   │ ⏳ Elapsed (start):   ${timeSinceStart}s`);
        console.log(`   │ ⏳ Elapsed (created): ${timeSinceCreated}s`);
        console.log(`   │ 🏆 Winner:            ${match.winner_address?.slice(0, 10)}...`);
        console.log(`   └─────────────────────────────────────────────────────`);

        try {
            await supabase.from('matches').update({ payout_status: 'PROCESSING' }).eq('id', match.id);
            console.log(`   📤 Sending blockchain transaction...`);
            const txStart = Date.now();
            const tx = await escrow.distributeWinnings(numericToBytes32(match.contract_match_id), match.winner_address);
            console.log(`   📝 TX Hash: ${tx.hash}`);
            await tx.wait();
            const txDuration = Math.round((Date.now() - txStart) / 1000);
            console.log(`   ✅ PAID! (TX took ${txDuration}s)`);
            await supabase.from('matches').update({ payout_status: 'PAID' }).eq('id', match.id);
            await resetServer(supabase, match.id);
        } catch (e) {
            console.error(`   ❌ Payout Failed: ${e.message}`);
            await supabase.from('matches').update({ payout_status: 'FAILED' }).eq('id', match.id);
        }
    }
}

async function refundPlayer(supabase, escrow, match, playerAddress) {
    try {
        console.log(`   🔒 Refunding match ${match.contract_match_id}...`);
        const matchIdBytes = numericToBytes32(match.contract_match_id);
        const matchData = await escrow.matches(matchIdBytes);
        const pot = matchData[2];

        if (pot.toString() !== '0') {
            const tx = await escrow.refundMatch(matchIdBytes, playerAddress);
            await tx.wait();
            await supabase.from('matches').update({ payout_status: 'REFUNDED', refund_tx_hash: tx.hash }).eq('id', match.id);
            console.log(`   ✅ Refunded.`);
        } else {
            await supabase.from('matches').update({ payout_status: 'REFUNDED' }).eq('id', match.id);
            console.log(`   ✅ No pot to refund (already empty).`);
        }
    } catch (e) {
        console.error(`   ❌ Refund error:`, e.message);
        await supabase.from('matches').update({ payout_status: 'REFUND_FAILED' }).eq('id', match.id);
    }
}

async function resetServer(supabase, matchId) {
    const { data: server } = await supabase.from('game_servers').select('*').eq('current_match_id', matchId).single();
    if (server) {
        console.log(`   🔄 Resetting Server ${server.name}`);
        await sendRcon(server.dathost_id, 'css_endmatch');
        await sendRcon(server.dathost_id, 'host_workshop_map 3344743064');
        await supabase.from('game_servers').update({ status: 'FREE', current_match_id: null }).eq('id', server.id);
    }
    warmupState.delete(matchId);
    afkState.delete(matchId);
}

// MAIN LOOP
async function main() {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);

    console.log("🤖 Bot Started (Version F - Ultimate Architecture)");

    while (true) {
        try {
            await verifyDeposits(supabase, provider);
            await assignServers(supabase);
            await checkAutoStart(supabase, escrow);
            await checkForfeits(supabase);
            await processPayouts(supabase, escrow);
        } catch (e) {
            console.error("Loop Error:", e);
        }
        await new Promise(r => setTimeout(r, 5000));
    }
}

main();