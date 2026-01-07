const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '.env.local') });
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Configuration
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_ADDRESS;
const PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY;
const RPC_URL = "https://sepolia.base.org";
const DATHOST_USER = process.env.DATHOST_USERNAME || process.env.DATHOST_USER;
const DATHOST_PASS = process.env.DATHOST_PASSWORD || process.env.DATHOST_PASS;

// ABI
const ESCROW_ABI = [
    "function distributeWinnings(bytes32 matchId, address winner) external",
    "function refundMatch(bytes32 matchId, address player) external"
];

// Helper: Convert numeric ID to bytes32
function numericToBytes32(num) {
    const hex = BigInt(num).toString(16);
    return '0x' + hex.padStart(64, '0');
}

// State Tracking for Warmup Logic
// Map<matchId, timestamp_when_countdown_started>
const warmupTracker = new Map();

// ---------------------------------------------------------
// 1. VERIFY DEPOSITS - Check blockchain for confirmed tx
// ---------------------------------------------------------
async function verifyDeposits(supabase, provider) {
    const { data: matches, error } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'DEPOSITING')
        .or('p1_tx_hash.not.is.null,p2_tx_hash.not.is.null');

    if (error || !matches || matches.length === 0) return;

    for (const match of matches) {
        // Re-check status to avoid race conditions
        const { data: freshMatch } = await supabase.from('matches').select('status').eq('id', match.id).single();
        if (!freshMatch || freshMatch.status !== 'DEPOSITING') continue;

        const verifyTx = async (txHash) => {
            try {
                const receipt = await provider.getTransactionReceipt(txHash);
                return receipt && receipt.status === 1;
            } catch (e) { return false; }
        };

        // Verify P1 deposit
        if (match.p1_tx_hash && !match.p1_deposited && await verifyTx(match.p1_tx_hash)) {
            console.log(`✅ P1 Deposit VERIFIED for match ${match.contract_match_id}`);
            await supabase.from('matches').update({ p1_deposited: true }).eq('id', match.id);
        }

        // Verify P2 deposit
        if (match.p2_tx_hash && !match.p2_deposited && await verifyTx(match.p2_tx_hash)) {
            console.log(`✅ P2 Deposit VERIFIED for match ${match.contract_match_id}`);
            await supabase.from('matches').update({ p2_deposited: true }).eq('id', match.id);
        }
    }
}

// ---------------------------------------------------------
// 2. ASSIGN SERVERS - When both deposits confirmed
// ---------------------------------------------------------
async function assignServers(supabase) {
    // Get matches where BOTH deposits are confirmed
    const { data: matches } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'DEPOSITING')  // FIXED: was 'WAITING', should be 'DEPOSITING'
        .eq('p1_deposited', true)
        .eq('p2_deposited', true)
        .is('server_id', null);  // Not yet assigned

    if (!matches || matches.length === 0) return;

    // Get Free Servers
    const { data: servers } = await supabase
        .from('game_servers')
        .select('*')
        .eq('status', 'FREE')
        .limit(matches.length);

    if (!servers || servers.length === 0) {
        console.log(`⚠️ No free servers available for ${matches.length} pending match(es).`);
        return;
    }

    // Assign servers
    for (let i = 0; i < Math.min(matches.length, servers.length); i++) {
        const match = matches[i];
        const server = servers[i];

        console.log(`🎮 Assigning Match ${match.contract_match_id} to Server ${server.name}...`);

        // Prepare Server via DatHost API
        const commands = [
            'get5_endmatch',
            'css_endmatch',
            'host_workshop_map 3344743064',
            'exec 1v1.cfg'
        ];

        await sendRcon(server.dathost_id, commands);

        // Update match to LIVE
        await supabase.from('matches').update({
            status: 'LIVE',
            server_id: server.id,
            server_assigned_at: new Date().toISOString()
        }).eq('id', match.id);

        // Mark server as BUSY
        await supabase.from('game_servers').update({
            status: 'BUSY',
            current_match_id: match.id
        }).eq('id', server.id);

        console.log(`   🚀 Match ${match.contract_match_id} is now LIVE!`);
    }
}


// ---------------------------------------------------------
// 3. CHECK AUTO START (The Warmup Fix)
// ---------------------------------------------------------
async function checkAutoStart(supabase) {
    // Fetch LIVE matches
    const { data: matches } = await supabase
        .from('matches')
        .select(`*, game_servers(*)`)
        .eq('status', 'LIVE');

    if (!matches) return;

    for (const match of matches) {
        if (!match.game_servers) continue;
        const serverId = match.game_servers.dathost_id;

        // 1. Poll DatHost for Player Count (HTTP > UDP)
        const info = await getDatHostServerInfo(serverId);
        if (!info) continue;

        const playerCount = info.players_online; // Verify field name in DatHost API response

        // Logic: 
        // 0-1 Players: Wait (Monitor for timeout handled in checkForfeits/Timeouts)
        // 2 Players: Trigger Countdown -> Force Start

        if (playerCount >= 2) {
            // Check if we already started the countdown
            if (!warmupTracker.has(match.id)) {
                console.log(`Match ${match.id}: 2 Players connected. Shortening timer.`);

                // FORCE Shorten Timer
                await sendRcon(serverId, [
                    'mp_warmuptime 30',
                    'mp_warmup_pausetimer 0',
                    'say "Both players connected! Match starts in 30 seconds..."',
                    'say "Type .ready to start immediately!"'
                ]);

                warmupTracker.set(match.id, Date.now());
            } else {
                // Countdown is running. Check if we need to FORCE START.
                const startTime = warmupTracker.get(match.id);
                const elapsed = Date.now() - startTime;

                if (elapsed > 35000) { // 35 seconds buffer
                    console.log(`Match ${match.id}: Timer expired. Forcing start.`);

                    // FORCE START via MatchZy
                    await sendRcon(serverId, [
                        'css_start', // MatchZy command to force Live
                        'say "Warmup expired. Forcing start!"'
                    ]);

                    // Remove from tracker so we don't spam commands (MatchZy handles it from here)
                    // We keep it in map with a far future time or remove it if we track 'IN_PROGRESS' status
                    warmupTracker.set(match.id, Date.now() + 9999999);
                }
            }
        } else {
            // If a player drops during countdown, reset?
            if (warmupTracker.has(match.id)) {
                // Optional: Reset timer if player leaves? 
                // For now, let's keep it simple.
            }
        }
    }
}

// ---------------------------------------------------------
// 4. FORFEIT / DISCONNECT MONITOR
// ---------------------------------------------------------
async function checkForfeits(supabase) {
    const { data: matches } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'LIVE');

    if (!matches) return;

    // Filter for matches with disconnect timestamps in JS
    const disconnectMatches = matches.filter(m => m.player1_disconnect_time || m.player2_disconnect_time);
    const FORFEIT_TIMEOUT = 5 * 60 * 1000; // 5 mins
    const now = Date.now();

    for (const match of disconnectMatches) {
        let winnerAddress = null;

        if (match.player1_disconnect_time && (now - new Date(match.player1_disconnect_time).getTime() > FORFEIT_TIMEOUT)) {
            winnerAddress = match.player2_address;
        } else if (match.player2_disconnect_time && (now - new Date(match.player2_disconnect_time).getTime() > FORFEIT_TIMEOUT)) {
            winnerAddress = match.player1_address;
        }

        if (winnerAddress) {
            console.log(`Match ${match.id}: Forfeit triggered.`);
            await supabase.from('matches').update({
                status: 'COMPLETE',
                winner_address: winnerAddress,
                payout_status: 'PENDING'
            }).eq('id', match.id);

            await resetServer(supabase, match.id);
        }
    }
}

// ---------------------------------------------------------
// 5. PAYOUT PROCESSOR
// ---------------------------------------------------------
async function processPayouts(supabase, escrow) {
    const { data: matches } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'COMPLETE')
        .eq('payout_status', 'PENDING');

    if (!matches || matches.length === 0) return;

    for (const match of matches) {
        console.log(`Paying out Match ${match.id}...`);
        try {
            await supabase.from('matches').update({ payout_status: 'PROCESSING' }).eq('id', match.id);

            const tx = await escrow.distributeWinnings(numericToBytes32(match.contract_match_id), match.winner_address);
            console.log(`Tx: ${tx.hash}`);
            await tx.wait();

            await supabase.from('matches').update({ payout_status: 'PAID' }).eq('id', match.id);
            await resetServer(supabase, match.id); // Ensure server is freed
        } catch (e) {
            console.error(`Payout Failed: ${e.message}`);
            await supabase.from('matches').update({ payout_status: 'FAILED' }).eq('id', match.id);
        }
    }
}

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------
async function resetServer(supabase, matchId) {
    const { data: server } = await supabase
        .from('game_servers')
        .select('*')
        .eq('current_match_id', matchId)
        .single();

    if (!server) return;

    console.log(`Resetting Server ${server.id}...`);

    // SOFT RESET: End match and Reload Map (Kicks players to lobby usually)
    await sendRcon(server.dathost_id, [
        'css_endmatch',
        'host_workshop_map 3344743064' // Reloading map is the cleanest "Kick" without rebooting
    ]);

    // Cleanup Memory Map
    warmupTracker.delete(matchId);

    // Free DB
    await supabase.from('game_servers').update({ status: 'FREE', current_match_id: null }).eq('id', server.id);
}

async function getDatHostServerInfo(dathostId) {
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');
    try {
        const res = await fetch(`https://dathost.net/api/0.1/game-servers/${dathostId}`, {
            headers: { 'Authorization': `Basic ${auth}` }
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.error("DatHost API Error:", e);
        return null;
    }
}

async function sendRcon(dathostId, lines) {
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
            console.error("RCON Error:", e);
        }
    }
}

// ---------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------
async function main() {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error("Missing SUPABASE credentials");
        process.exit(1);
    }
    if (!PRIVATE_KEY) {
        console.error("Missing PAYOUT_PRIVATE_KEY");
        process.exit(1);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);

    console.log("Bot Started.");

    while (true) {
        console.log(`[${new Date().toISOString()}] Bot cycle...`);
        try {
            // Run sequentially
            await verifyDeposits(supabase, provider);
            await assignServers(supabase);
            await checkAutoStart(supabase);
            await checkForfeits(supabase);
            await processPayouts(supabase, escrow);
        } catch (e) {
            console.error("Loop Error:", e);
        }

        // Wait 5 seconds
        await new Promise(r => setTimeout(r, 5000));
    }
}

main();