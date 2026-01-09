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
const AFK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes for warmup AFK
const FORFEIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for in-game forfeit

// --- HELPERS ---

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
        return await response.text();
    } catch (e) {
        console.error("RCON Error:", e.message);
        return null;
    }
}

// IMPROVEMENT #1: Use DatHost status_json instead of parsing 'status' output
async function getRealPlayerCount(dathostId) {
    if (!DATHOST_USER || !DATHOST_PASS) return 0;
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');

    try {
        const res = await fetch(`https://dathost.net/api/0.1/game-servers/${dathostId}`, {
            method: 'GET',
            headers: { 'Authorization': `Basic ${auth}` }
        });

        if (!res.ok) {
            console.error(`status_json failed: ${res.status} ${res.statusText}`);
            return 0;
        }

        const json = await res.json();
        // DatHost returns players_online directly
        return json.players_online || 0;
    } catch (e) {
        console.error("status_json error:", e.message);
        return 0;
    }
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

        await sendRcon(server.dathost_id, 'get5_endmatch');
        await sendRcon(server.dathost_id, 'css_endmatch');
        await sendRcon(server.dathost_id, 'host_workshop_map 3344743064');
        await sendRcon(server.dathost_id, 'exec MatchZy/warmup.cfg');

        await supabase.from('matches').update({ status: 'LIVE', server_assigned_at: new Date().toISOString() }).eq('id', match.id);
        console.log(`[${new Date().toISOString()}] 🚀 Match ${match.contract_match_id} is LIVE! (60s Warmup)`);
    }
}

// OBSERVER + FAILSAFE (uses server truth)
async function checkAutoStart(supabase, escrow) {
    const now = Date.now();
    const { data: matches } = await supabase.from('matches').select('*').eq('status', 'LIVE').is('match_started_at', null);
    if (!matches) return;

    for (const match of matches) {
        if (match.server_assigned_at && now - new Date(match.server_assigned_at).getTime() < 10000) continue;
        const { data: server } = await supabase.from('game_servers').select('*').eq('current_match_id', match.id).single();
        if (!server) continue;

        // SOURCE OF TRUTH: DatHost API
        const playerCount = await getRealPlayerCount(server.dathost_id);
        console.log(`   📊 Match ${match.contract_match_id}: ${playerCount} Players (Server Verified)`);

        // 1. NOT ENOUGH PLAYERS
        if (playerCount < 2) {
            warmupState.delete(match.id);

            if (!afkState.has(match.id)) {
                console.log(`   👤 Match ${match.contract_match_id}: Waiting for players. Starting AFK timer.`);
                afkState.set(match.id, { start: now });
            } else {
                const elapsed = now - afkState.get(match.id).start;

                if (elapsed > AFK_TIMEOUT_MS) {
                    console.log(`[${new Date().toISOString()}] ⏰ Match ${match.contract_match_id}: AFK Timeout.`);
                    await sendRcon(server.dathost_id, 'say "Match Cancelled (AFK)"');
                    await sendRcon(server.dathost_id, 'css_endmatch');

                    // IMPROVEMENT #5: Refund BOTH players
                    await refundBothPlayers(supabase, escrow, match);

                    await supabase.from('matches').update({ status: 'CANCELLED' }).eq('id', match.id);
                    await supabase.from('game_servers').update({ status: 'FREE', current_match_id: null }).eq('id', server.id);
                    afkState.delete(match.id);
                }
            }
            continue;
        }

        // 2. BOTH CONNECTED
        if (playerCount >= 2) {
            if (afkState.has(match.id)) afkState.delete(match.id);

            if (!warmupState.has(match.id)) {
                console.log(`   ✅ Both Connected. Config timer running...`);
                warmupState.set(match.id, { start: now });
            } else {
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

// IMPROVEMENT #2: Forfeits use SERVER TRUTH, not DB disconnect timestamps
async function checkForfeits(supabase, escrow) {
    const { data: matches } = await supabase.from('matches').select('*').eq('status', 'LIVE').not('match_started_at', 'is', null);
    if (!matches) return;

    const now = Date.now();

    for (const match of matches) {
        const { data: server } = await supabase.from('game_servers').select('*').eq('current_match_id', match.id).single();
        if (!server) continue;

        // Ask the server how many players are actually there
        const playerCount = await getRealPlayerCount(server.dathost_id);

        // If only 1 player during LIVE match, track for forfeit
        if (playerCount < 2) {
            if (!afkState.has(`forfeit_${match.id}`)) {
                console.log(`   ⚠️ Match ${match.contract_match_id}: Only ${playerCount} player(s) during LIVE. Starting forfeit timer.`);
                afkState.set(`forfeit_${match.id}`, { start: now });
            } else {
                const elapsed = now - afkState.get(`forfeit_${match.id}`).start;

                if (elapsed > FORFEIT_TIMEOUT_MS) {
                    console.log(`[${new Date().toISOString()}] 🚨 Match ${match.contract_match_id}: Forfeit (player left for 5min).`);

                    // We don't know WHO left without more info, so cancel and refund
                    await sendRcon(server.dathost_id, 'say "Match Cancelled (Forfeit)"');
                    await sendRcon(server.dathost_id, 'css_endmatch');
                    await refundBothPlayers(supabase, escrow, match);
                    await supabase.from('matches').update({ status: 'CANCELLED' }).eq('id', match.id);
                    await supabase.from('game_servers').update({ status: 'FREE', current_match_id: null }).eq('id', server.id);
                    afkState.delete(`forfeit_${match.id}`);
                }
            }
        } else {
            // Reset forfeit timer if both players are back
            afkState.delete(`forfeit_${match.id}`);
        }
    }
}

// IMPROVEMENT #3: On-chain idempotency check before paying
async function processPayouts(supabase, escrow) {
    const { data: matches } = await supabase.from('matches').select('*').eq('status', 'COMPLETE').eq('payout_status', 'PENDING');
    if (!matches || matches.length === 0) return;

    console.log(`\n💰 [${new Date().toISOString()}] Processing ${matches.length} payout(s)...`);

    for (const match of matches) {
        console.log(`   💰 PAYOUT: Match ${match.contract_match_id}`);

        try {
            // CHECK ON-CHAIN STATE FIRST (idempotency)
            const matchIdBytes = numericToBytes32(match.contract_match_id);
            const onchain = await escrow.matches(matchIdBytes);
            const isComplete = onchain[3]; // isComplete is index 3

            if (isComplete) {
                console.log(`   ⏭️ Already paid on-chain. Updating DB.`);
                await supabase.from('matches').update({
                    payout_status: 'PAID',
                    payout_note: 'Already complete on-chain'
                }).eq('id', match.id);
                await resetServer(supabase, match.id);
                continue;
            }

            // Store TX hash BEFORE sending (for crash recovery)
            await supabase.from('matches').update({ payout_status: 'PROCESSING' }).eq('id', match.id);

            console.log(`   📤 Sending blockchain transaction...`);
            const txStart = Date.now();
            const tx = await escrow.distributeWinnings(matchIdBytes, match.winner_address);

            // Store TX hash immediately
            await supabase.from('matches').update({ payout_tx_hash: tx.hash }).eq('id', match.id);
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

// IMPROVEMENT #5: Refund BOTH players
async function refundBothPlayers(supabase, escrow, match) {
    const matchIdBytes = numericToBytes32(match.contract_match_id);

    try {
        const onchain = await escrow.matches(matchIdBytes);
        const pot = onchain[2];

        if (pot.toString() === '0') {
            console.log(`   ✅ No pot to refund (already empty).`);
            await supabase.from('matches').update({ payout_status: 'REFUNDED' }).eq('id', match.id);
            return;
        }

        // Refund P1
        if (match.player1_address) {
            try {
                console.log(`   🔒 Refunding P1: ${match.player1_address.slice(0, 10)}...`);
                const tx1 = await escrow.refundMatch(matchIdBytes, match.player1_address);
                await tx1.wait();
                console.log(`   ✅ P1 Refunded.`);
            } catch (e) {
                console.error(`   ⚠️ P1 Refund error: ${e.message}`);
            }
        }

        // Refund P2
        if (match.player2_address) {
            try {
                console.log(`   🔒 Refunding P2: ${match.player2_address.slice(0, 10)}...`);
                const tx2 = await escrow.refundMatch(matchIdBytes, match.player2_address);
                await tx2.wait();
                console.log(`   ✅ P2 Refunded.`);
            } catch (e) {
                console.error(`   ⚠️ P2 Refund error: ${e.message}`);
            }
        }

        await supabase.from('matches').update({ payout_status: 'REFUNDED' }).eq('id', match.id);
    } catch (e) {
        console.error(`   ❌ Refund error: ${e.message}`);
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
    afkState.delete(`forfeit_${matchId}`);
}

// MAIN LOOP
async function main() {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);

    console.log("🤖 Bot Started (Version G - Best Practices)");

    while (true) {
        try {
            await verifyDeposits(supabase, provider);
            await assignServers(supabase);
            await checkAutoStart(supabase, escrow);
            await checkForfeits(supabase, escrow);
            await processPayouts(supabase, escrow);
        } catch (e) {
            console.error("Loop Error:", e);
        }
        await new Promise(r => setTimeout(r, 5000));
    }
}

main();
