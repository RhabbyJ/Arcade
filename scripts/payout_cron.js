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

// Configuration
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

// State Tracking
const warmupState = new Map();
const afkState = new Map();
const WARMUP_COUNTDOWN_MS = 30 * 1000;
const AFK_TIMEOUT_MS = 2 * 60 * 1000;

// --- HELPERS ---

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 5000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

async function sendRcon(dathostId, lines) {
    if (!DATHOST_USER || !DATHOST_PASS) return;
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');

    for (const line of lines) {
        try {
            await fetchWithTimeout(`https://dathost.net/api/0.1/game-servers/${dathostId}/console`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({ line })
            });
        } catch (e) {
            console.error("RCON Error:", e.message);
        }
    }
}

// --- LOGIC ---

async function verifyDeposits(supabase, provider) {
    const { data: matches } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'DEPOSITING')
        .or('p1_deposited.eq.false,p2_deposited.eq.false');

    if (!matches) return;

    for (const match of matches) {
        if (match.p1_tx_hash && !match.p1_deposited) {
            try {
                const tx = await provider.getTransactionReceipt(match.p1_tx_hash);
                if (tx && tx.status === 1) {
                    console.log(`[${new Date().toISOString()}] ✅ P1 Deposit VERIFIED: Match ${match.contract_match_id}`);
                    await supabase.from('matches').update({ p1_deposited: true }).eq('id', match.id);
                }
            } catch (e) { console.error("Tx Check Error:", e.message); }
        }
        if (match.p2_tx_hash && !match.p2_deposited) {
            try {
                const tx = await provider.getTransactionReceipt(match.p2_tx_hash);
                if (tx && tx.status === 1) {
                    console.log(`[${new Date().toISOString()}] ✅ P2 Deposit VERIFIED: Match ${match.contract_match_id}`);
                    await supabase.from('matches').update({ p2_deposited: true }).eq('id', match.id);
                }
            } catch (e) { console.error("Tx Check Error:", e.message); }
        }
    }
}

async function assignServers(supabase) {
    const { data: matches } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'DEPOSITING')
        .eq('p1_deposited', true)
        .eq('p2_deposited', true);

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

        await sendRcon(server.dathost_id, [
            'get5_endmatch',
            'css_endmatch',
            'host_workshop_map 3344743064',
            'exec 1v1.cfg'
        ]);

        await supabase.from('matches').update({
            status: 'LIVE',
            server_assigned_at: new Date().toISOString()
        }).eq('id', match.id);

        console.log(`[${new Date().toISOString()}] 🚀 Match ${match.contract_match_id} is LIVE! (Warmup Phase)`);
    }
}

async function checkAutoStart(supabase, escrow) {
    const now = Date.now();
    const { data: matches } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'LIVE')
        .is('match_started_at', null);

    if (!matches) return;

    for (const match of matches) {
        if (match.server_assigned_at && now - new Date(match.server_assigned_at).getTime() < 15000) continue;

        const { data: server } = await supabase.from('game_servers').select('*').eq('current_match_id', match.id).single();
        if (!server) continue;

        let playerCount = 0;
        if (match.player1_disconnect_time === null) playerCount++;
        if (match.player2_disconnect_time === null) playerCount++;

        console.log(`   📊 Match ${match.contract_match_id}: ${playerCount} Players Connected (DB Check)`);

        if (playerCount === 0) {
            warmupState.delete(match.id);
            afkState.delete(match.id);
            continue;
        }

        // --- 1 PLAYER (AFK Logic) ---
        if (playerCount === 1) {
            warmupState.delete(match.id);
            if (!afkState.has(match.id)) {
                console.log(`   👤 Match ${match.contract_match_id}: P1 waiting. Starting 2-min AFK timer.`);
                afkState.set(match.id, { start: now });
            } else {
                const elapsed = now - afkState.get(match.id).start;
                const remaining = Math.max(0, AFK_TIMEOUT_MS - elapsed);

                if (remaining > 0 && remaining % 30000 < 5000) {
                    console.log(`   ⏳ Match ${match.contract_match_id}: ${Math.ceil(remaining / 1000)}s until AFK cancel`);
                }

                if (elapsed > AFK_TIMEOUT_MS) {
                    console.log(`[${new Date().toISOString()}] ⏰ Match ${match.contract_match_id}: AFK Timeout.`);
                    await sendRcon(server.dathost_id, ['say "Match Cancelled (AFK)"', 'css_endmatch', 'host_workshop_map 3344743064']);
                    await refundPlayer(supabase, escrow, match, match.player1_address);
                    await supabase.from('matches').update({ status: 'CANCELLED', payout_status: 'REFUND_PENDING' }).eq('id', match.id);
                    await supabase.from('game_servers').update({ status: 'FREE', current_match_id: null }).eq('id', server.id);
                    afkState.delete(match.id);
                }
            }
            continue;
        }

        // --- 2 PLAYERS (Warmup Director) ---
        if (playerCount >= 2) {
            if (afkState.has(match.id)) afkState.delete(match.id);

            if (!warmupState.has(match.id)) {
                // Buffer to allow initial loading
                console.log(`   ⏳ Both Connected. Waiting 5s for stability...`);
                await new Promise(r => setTimeout(r, 5000));

                console.log(`[${new Date().toISOString()}] 🎯 Match ${match.contract_match_id}: RESTARTING Warmup to 30s.`);

                // NOW WE CAN SAFELY USE mp_warmup_start!
                // Config is neutralized (no mp_warmuptime in warmup.cfg)
                await sendRcon(server.dathost_id, [
                    'mp_warmup_end',
                    'mp_warmuptime 30',
                    'mp_warmup_start',        // This updates the HUD!
                    'mp_warmup_pausetimer 0',
                    'say "Both players connected! Match starts in 30s..."',
                    'say "Type .ready to skip wait!"'
                ]);

                warmupState.set(match.id, { start: Date.now(), started: false });
            } else {
                const state = warmupState.get(match.id);
                if (!state.started && now - state.start > WARMUP_COUNTDOWN_MS) {
                    console.log(`[${new Date().toISOString()}] 🚦 Match ${match.contract_match_id}: FORCE-START (30s elapsed)`);
                    await sendRcon(server.dathost_id, ['css_start', 'say "GLHF!"']);
                    await supabase.from('matches').update({ match_started_at: new Date().toISOString() }).eq('id', match.id);
                    state.started = true;
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
        await sendRcon(server.dathost_id, ['css_endmatch', 'host_workshop_map 3344743064']);
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

    console.log("🤖 Bot Started (Version C.3 - Config Neutralized + Force Start)");

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