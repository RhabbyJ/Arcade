const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const path = require('path');
const dotenv = require('dotenv');

const fs = require('fs');

// Load env vars - Try multiple paths
const envPaths = [
    path.resolve(__dirname, '../.env.local'), // Local Dev
    path.resolve('/root/base-bot/.env.local'), // VPS Prod
    path.resolve(process.cwd(), '.env.local')  // Current Dir
];

let envLoaded = false;
for (const p of envPaths) {
    if (fs.existsSync(p)) {
        dotenv.config({ path: p });
        console.log(`Loaded env from: ${p}`);
        envLoaded = true;
        break;
    }
}
if (!envLoaded) console.warn("⚠️ No .env.local found! Relying on system process.env");

// Configuration
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL; // Fallback
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY; // Fallback
const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_ADDRESS;
const PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY;
const RPC_URL = "https://sepolia.base.org";
const DATHOST_USER = process.env.DATHOST_USERNAME;
const DATHOST_PASS = process.env.DATHOST_PASSWORD;
const DATHOST_PASS = process.env.DATHOST_PASSWORD;

// ABI
const ESCROW_ABI = [
    "function distributeWinnings(bytes32 matchId, address winner) external",
    "function refundMatch(bytes32 matchId, address player) external",
    "function matches(bytes32) view returns (address player1, address player2, uint256 pot, bool isComplete, bool isActive)"
];

// Helper: Convert numeric ID to bytes32
function numericToBytes32(num) {
    const hex = BigInt(num).toString(16);
    return '0x' + hex.padStart(64, '0');
}

// State Tracking for Warmup Logic
const warmupTracker = new Map();

// ---------------------------------------------------------
// NETWORK HELPERS
// ---------------------------------------------------------
async function getDatHostServerInfo(dathostId) {
    if (!DATHOST_USER || !DATHOST_PASS) return null;
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const res = await fetch(`https://dathost.net/api/0.1/game-servers/${dathostId}`, {
            headers: { 'Authorization': `Basic ${auth}` },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.error("DatHost API Error:", e.message);
        return null;
    }
}

async function sendRcon(dathostId, lines) {
    if (!DATHOST_USER || !DATHOST_PASS) return;
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');

    for (const line of lines) {
        try {
            await fetch(`https://dathost.net/api/0.1/game-servers/${dathostId}/console`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({ line }).toString()
            });
        } catch (e) {
            console.error("RCON Error:", e.message);
        }
    }
}

// ---------------------------------------------------------
// 1. VERIFY DEPOSITS
// ---------------------------------------------------------
async function verifyDeposits(supabase, provider) {
    const { data: matches } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'DEPOSITING')
        .or('p1_deposited.eq.false,p2_deposited.eq.false');

    if (!matches) return;

    for (const match of matches) {
        // Verify P1
        if (match.p1_tx_hash && !match.p1_deposited) {
            try {
                const tx = await provider.getTransactionReceipt(match.p1_tx_hash);
                if (tx && tx.status === 1) {
                    console.log(`✅ P1 Deposit Verified: ${match.id}`);
                    await supabase.from('matches').update({ p1_deposited: true }).eq('id', match.id);
                }
            } catch (e) { console.error("Tx Check Error:", e.message); }
        }

        // Verify P2
        if (match.p2_tx_hash && !match.p2_deposited) {
            try {
                const tx = await provider.getTransactionReceipt(match.p2_tx_hash);
                if (tx && tx.status === 1) {
                    console.log(`✅ P2 Deposit Verified: ${match.id}`);
                    await supabase.from('matches').update({ p2_deposited: true }).eq('id', match.id);
                }
            } catch (e) { console.error("Tx Check Error:", e.message); }
        }
    }
}

// ---------------------------------------------------------
// 2. ASSIGN SERVERS
// ---------------------------------------------------------
async function assignServers(supabase) {
    // 1. Find matches ready for a server
    const { data: matches } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'DEPOSITING')
        .eq('p1_deposited', true)
        .eq('p2_deposited', true);

    if (!matches || matches.length === 0) return;

    // 2. Find free servers
    const { data: servers } = await supabase
        .from('game_servers')
        .select('*')
        .eq('status', 'FREE')
        .limit(matches.length);

    if (!servers || servers.length === 0) {
        console.log("⚠️ No free servers available for pending matches.");
        return;
    }

    // 3. Assign
    for (let i = 0; i < Math.min(matches.length, servers.length); i++) {
        const match = matches[i];
        const server = servers[i];

        console.log(`🎮 Assigning Server ${server.name} to Match ${match.id}`);

        // A. Lock Server FIRST
        await supabase.from('game_servers').update({
            status: 'BUSY',
            current_match_id: match.id
        }).eq('id', server.id);

        // B. Configure Server
        const commands = [
            'get5_endmatch',
            'css_endmatch',
            'host_workshop_map 3344743064', // Reload map
            'exec 1v1.cfg'
        ];
        await sendRcon(server.dathost_id, commands);

        // C. Set Match to LIVE
        await supabase.from('matches').update({
            status: 'LIVE',
            server_id: server.id,
            match_start_time: new Date().toISOString()
        }).eq('id', match.id);

        console.log(`🚀 Match ${match.id} is LIVE!`);
    }
}

// ---------------------------------------------------------
// 3. CHECK AUTO START (Warmup Director)
// ---------------------------------------------------------
async function checkAutoStart(supabase) {
    const { data: matches } = await supabase
        .from('matches')
        .select(`*, game_servers(*)`)
        .eq('status', 'LIVE');

    if (!matches) return;

    for (const match of matches) {
        // Handle failed join or missing server data
        if (!match.game_servers || !match.game_servers.dathost_id) {
            const { data: server } = await supabase.from('game_servers').select('*').eq('current_match_id', match.id).single();
            if (!server) continue;
            match.game_servers = server;
        }

        const serverId = match.game_servers.dathost_id;
        const info = await getDatHostServerInfo(serverId);
        if (!info) continue;

        const playerCount = info.players_online;

        // 2 Players -> Shorten Timer -> Wait 30s -> Force Start
        if (playerCount >= 2) {
            if (!warmupTracker.has(match.id)) {
                console.log(`Match ${match.id}: 2 Players! Starting 30s countdown.`);
                await sendRcon(serverId, [
                    'mp_warmuptime 30',
                    'mp_warmup_pausetimer 0',
                    'say "Both players connected! Match starts in 30s..."',
                    'say "Type .ready to skip wait!"'
                ]);
                warmupTracker.set(match.id, Date.now());
            } else {
                const startTime = warmupTracker.get(match.id);
                if (Date.now() - startTime > 35000) {
                    if (startTime < 4000000000000) {
                        console.log(`Match ${match.id}: Forcing start.`);
                        await sendRcon(serverId, ['css_start', 'say "Warmup expired. GLHF!"']);
                        warmupTracker.set(match.id, 9999999999999);
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------
// 4. DEPOSIT TIMEOUT MONITOR (RESTORED)
// ---------------------------------------------------------
async function checkTimeouts(supabase, escrow) {
    const now = Date.now();
    const { data: depositing } = await supabase.from('matches').select('*').eq('status', 'DEPOSITING');

    if (!depositing || depositing.length === 0) return;

    for (const m of depositing) {
        const start = m.deposit_started_at || m.created_at;
        const startTime = new Date(start).getTime();

        // 15 min timeout
        if (now - startTime > 15 * 60 * 1000) {
            console.log(`⏰ Match ${m.contract_match_id} timed out.`);

            if (m.p1_deposited || m.p2_deposited) {
                const refundAddr = m.p1_deposited ? m.player1_address : m.player2_address;
                await refundPlayer(supabase, escrow, m, refundAddr);
            } else {
                await supabase.from('matches').update({ status: 'CANCELLED' }).eq('id', m.id);
            }
        }
    }
}

async function refundPlayer(supabase, escrow, match, playerAddress) {
    try {
        console.log(`   🔒 Refunding match ${match.contract_match_id}...`);
        // Check pot on chain mockup
        const matchIdBytes = numericToBytes32(match.contract_match_id);
        const matchData = await escrow.matches(matchIdBytes);
        const pot = matchData[2];

        if (pot.toString() !== '0') {
            const tx = await escrow.refundMatch(matchIdBytes, playerAddress);
            await tx.wait();
            await supabase.from('matches').update({ status: 'CANCELLED', payout_status: 'REFUNDED', refund_tx_hash: tx.hash }).eq('id', match.id);
            console.log(`   ✅ Refunded.`);
        } else {
            await supabase.from('matches').update({ status: 'CANCELLED', payout_status: 'REFUNDED' }).eq('id', match.id);
        }
    } catch (e) {
        console.error(`   Refund error:`, e.message);
        await supabase.from('matches').update({ status: 'CANCELLED', payout_status: 'REFUND_FAILED' }).eq('id', match.id);
    }
}

// ---------------------------------------------------------
// 5. FORFEIT MONITOR
// ---------------------------------------------------------
async function checkForfeits(supabase) {
    const { data: matches } = await supabase.from('matches').select('*').eq('status', 'LIVE');
    if (!matches) return;

    const FORFEIT_TIMEOUT = 5 * 60 * 1000;
    const now = Date.now();

    for (const match of matches) {
        let winner = null;
        if (match.player1_disconnect_time && (now - new Date(match.player1_disconnect_time).getTime() > FORFEIT_TIMEOUT)) {
            winner = match.player2_address;
        } else if (match.player2_disconnect_time && (now - new Date(match.player2_disconnect_time).getTime() > FORFEIT_TIMEOUT)) {
            winner = match.player1_address;
        }

        if (winner) {
            console.log(`🚨 Match ${match.id} Forfeit. Winner: ${winner}`);
            await supabase.from('matches').update({
                status: 'COMPLETE',
                winner_address: winner,
                payout_status: 'PENDING'
            }).eq('id', match.id);
            await resetServer(supabase, match.id);
        }
    }
}

// ---------------------------------------------------------
// 6. PAYOUTS
// ---------------------------------------------------------
async function processPayouts(supabase, escrow) {
    const { data: matches } = await supabase.from('matches')
        .select('*').eq('status', 'COMPLETE').eq('payout_status', 'PENDING');

    if (!matches) return;

    for (const match of matches) {
        console.log(`💰 Paying Match ${match.id}...`);
        try {
            await supabase.from('matches').update({ payout_status: 'PROCESSING' }).eq('id', match.id);
            const tx = await escrow.distributeWinnings(numericToBytes32(match.contract_match_id), match.winner_address);
            console.log(`   Tx: ${tx.hash}`);
            await tx.wait();
            await supabase.from('matches').update({ payout_status: 'PAID' }).eq('id', match.id);
            await resetServer(supabase, match.id);
        } catch (e) {
            console.error(`   Payout Failed: ${e.message}`);
            await supabase.from('matches').update({ payout_status: 'FAILED' }).eq('id', match.id);
        }
    }
}

async function resetServer(supabase, matchId) {
    const { data: server } = await supabase.from('game_servers').select('*').eq('current_match_id', matchId).single();
    if (server) {
        console.log(`   Resetting Server ${server.name}`);
        await sendRcon(server.dathost_id, ['css_endmatch', 'host_workshop_map 3344743064']);
        await supabase.from('game_servers').update({ status: 'FREE', current_match_id: null }).eq('id', server.id);
    }
    warmupTracker.delete(matchId);
}

// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------
async function main() {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);

    console.log("🤖 Bot Started (Restored w/ Timeouts)");

    while (true) {
        try {
            await verifyDeposits(supabase, provider);
            await checkTimeouts(supabase, escrow); // Added Back!
            await assignServers(supabase);
            await checkAutoStart(supabase);
            await checkForfeits(supabase);
            await processPayouts(supabase, escrow);
        } catch (e) {
            console.error("Loop Error:", e);
        }
        await new Promise(r => setTimeout(r, 5000));
    }
}

main();