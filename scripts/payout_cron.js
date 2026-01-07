const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const path = require('path');
const dotenv = require('dotenv');

const fs = require('fs');

// Load env vars - Try multiple paths
const envPaths = [
    path.resolve(__dirname, '../.env.local'), // Local Dev
    path.resolve('/root/base-bot/.env.local'), // VPS Prod (.local)
    path.resolve('/root/base-bot/.env'),       // VPS Prod (standard)
    path.resolve(process.cwd(), '.env.local'), // Current Dir (.local)
    path.resolve(process.cwd(), '.env')        // Current Dir (standard)
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

// State Tracking for Warmup Logic (legacy, now using afkState/warmupState)

// ---------------------------------------------------------
// STARTUP CLEANUP - Reset orphaned servers
// ---------------------------------------------------------
async function cleanupOrphanedServers(supabase) {
    // Find servers that are BUSY but have no match assigned
    const { data: orphanedServers, error } = await supabase
        .from('game_servers')
        .select('id, name, status, current_match_id')
        .eq('status', 'BUSY')
        .is('current_match_id', null);

    if (error) {
        console.error("Error checking for orphaned servers:", error.message);
        return;
    }

    if (orphanedServers && orphanedServers.length > 0) {
        console.log(`🔧 Found ${orphanedServers.length} orphaned server(s), resetting to FREE...`);
        for (const server of orphanedServers) {
            console.log(`   - Resetting: ${server.name} (ID: ${server.id})`);
            await supabase
                .from('game_servers')
                .update({ status: 'FREE', current_match_id: null })
                .eq('id', server.id);
        }
        console.log("✅ Orphaned servers cleaned up");
    }
}


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
                    console.log(`[${new Date().toISOString()}] ✅ P1 Deposit VERIFIED: Match ${match.contract_match_id}`);
                    await supabase.from('matches').update({ p1_deposited: true }).eq('id', match.id);
                }
            } catch (e) { console.error("Tx Check Error:", e.message); }
        }

        // Verify P2
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

// ---------------------------------------------------------
// 2. ASSIGN SERVERS
// ---------------------------------------------------------
async function assignServers(supabase) {
    // 1. Find matches ready for a server
    const { data: matches, error: matchError } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'DEPOSITING')
        .eq('p1_deposited', true)
        .eq('p2_deposited', true);

    if (matchError) {
        console.error("Error fetching matches:", matchError.message);
        return;
    }

    if (!matches || matches.length === 0) return;

    console.log(`📋 Found ${matches.length} match(es) ready for server assignment`);

    // 2. Find free servers
    const { data: servers, error: serverError } = await supabase
        .from('game_servers')
        .select('*')
        .eq('status', 'FREE')
        .limit(matches.length);

    if (serverError) {
        console.error("Error fetching servers:", serverError.message);
        return;
    }

    if (!servers || servers.length === 0) {
        console.log("⚠️ No free servers available for pending matches.");
        return;
    }

    console.log(`🖥️ Found ${servers.length} free server(s)`);


    // 3. Assign
    for (let i = 0; i < Math.min(matches.length, servers.length); i++) {
        const match = matches[i];
        const server = servers[i];

        console.log(`[${new Date().toISOString()}] 🎮 Assigning Server ${server.name} to Match ${match.contract_match_id}`);

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

        // C. Set Match to LIVE (Warmup Phase)
        // NOTE: Do NOT set match_started_at here! That's only set when:
        // - Webhook receives 'going_live' (players typed .ready)
        // - Bot force-starts via css_start (after 30s countdown)
        const { error: updateError } = await supabase.from('matches').update({
            status: 'LIVE',
            server_assigned_at: new Date().toISOString()
        }).eq('id', match.id);

        if (updateError) {
            console.error(`❌ Failed to set match ${match.id} to LIVE:`, updateError.message);
            // Retry once
            const { error: retryError } = await supabase.from('matches').update({
                status: 'LIVE'
            }).eq('id', match.id);
            if (retryError) {
                console.error(`❌ Retry also failed:`, retryError.message);
            } else {
                console.log(`✅ Match ${match.id} set to LIVE on retry`);
            }
        } else {
            console.log(`[${new Date().toISOString()}] 🚀 Match ${match.contract_match_id} is LIVE! (Warmup Phase - waiting for players)`);
        }

    }
}

// ---------------------------------------------------------
// 3. WARMUP DIRECTOR (AFK + Auto-Start Logic)
// ---------------------------------------------------------
// State tracking for warmup/AFK logic
const afkState = new Map();     // match.id -> { start: timestamp }
const warmupState = new Map();  // match.id -> { start: timestamp, started: boolean }

const AFK_TIMEOUT_MS = 2 * 60 * 1000;       // 2 minutes for P1 waiting
const WARMUP_COUNTDOWN_MS = 30 * 1000;       // 30 seconds after P2 joins
const MINIMUM_WAIT_AFTER_LIVE = 15 * 1000;   // Wait for map to load

async function checkAutoStart(supabase, escrow) {
    const now = Date.now();

    // Only check matches that are LIVE but haven't started yet
    const { data: matches } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'LIVE')
        .is('match_started_at', null);

    if (!matches || matches.length === 0) return;
    if (!DATHOST_USER || !DATHOST_PASS) return;

    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');

    for (const match of matches) {
        // Wait for server to finish loading
        if (match.server_assigned_at && now - new Date(match.server_assigned_at).getTime() < MINIMUM_WAIT_AFTER_LIVE) {
            continue;
        }

        // Get the assigned server
        const { data: server } = await supabase
            .from('game_servers')
            .select('*')
            .eq('current_match_id', match.id)
            .single();

        if (!server) continue;

        // Helper for RCON commands
        const sendRconCmd = async (cmd) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                await fetch(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}/console`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: new URLSearchParams({ line: cmd }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
            } catch (e) {
                console.error(`   ⚠️ RCON error: ${e.message}`);
            }
        };

        // Fetch player count via DatHost API
        let playerCount = 0;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            const res = await fetch(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}`, {
                headers: { 'Authorization': `Basic ${auth}` },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                const data = await res.json();
                playerCount = data.players_online || 0;
            }
        } catch (e) {
            console.log(`   ⚠️ API timeout for match ${match.contract_match_id}`);
            continue;
        }

        console.log(`   📊 Match ${match.contract_match_id}: ${playerCount} player(s)`);

        // Skip if match started via .ready (webhook sets match_started_at)
        const { data: freshMatch } = await supabase
            .from('matches')
            .select('match_started_at')
            .eq('id', match.id)
            .single();

        if (freshMatch?.match_started_at) {
            warmupState.delete(match.id);
            afkState.delete(match.id);
            console.log(`   ✅ Match ${match.contract_match_id} started via .ready`);
            continue;
        }

        // === NO PLAYERS ===
        if (playerCount === 0) {
            warmupState.delete(match.id);
            afkState.delete(match.id);
            continue;
        }

        // === 1 PLAYER (P1 waiting for P2) ===
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

                if (elapsed >= AFK_TIMEOUT_MS) {
                    console.log(`   ⏰ Match ${match.contract_match_id}: P2 never joined. Cancelling + Refund.`);
                    await sendRconCmd('say "Opponent did not join in time. Match cancelled."');
                    await sendRconCmd('css_endmatch');
                    await sendRconCmd('mp_warmup_end');
                    await sendRconCmd('host_workshop_map 3344743064'); // Reload map to kick player

                    // Mark for refund
                    await supabase.from('matches').update({
                        status: 'CANCELLED',
                        payout_status: 'REFUND_PENDING'
                    }).eq('id', match.id);

                    // Free server
                    await supabase.from('game_servers').update({
                        status: 'FREE',
                        current_match_id: null
                    }).eq('id', server.id);

                    // Process refund for P1
                    await refundPlayer(supabase, escrow, match, match.player1_address);

                    afkState.delete(match.id);
                }
            }
            continue;
        }

        // === 2+ PLAYERS (Both connected) ===
        if (playerCount >= 2) {
            // Clear AFK timer
            if (afkState.has(match.id)) {
                console.log(`   👥 Match ${match.contract_match_id}: Both players connected! Starting 30s countdown.`);
                afkState.delete(match.id);
            }

            // Start warmup countdown
            if (!warmupState.has(match.id)) {
                warmupState.set(match.id, { start: now, started: false });
                // SYNC THE HUD: Force game timer to match our 30s countdown
                await sendRconCmd('mp_warmuptime 30');
                await sendRconCmd('mp_warmup_pausetimer 0');
                await sendRconCmd('say "Both players connected! Match starts in 30 seconds."');
                await sendRconCmd('say "Type .ready to skip the wait!"');
            }

            const state = warmupState.get(match.id);
            const elapsed = now - state.start;

            // Force-start after 30 seconds
            if (!state.started && elapsed >= WARMUP_COUNTDOWN_MS) {
                console.log(`[${new Date().toISOString()}] 🚦 Match ${match.contract_match_id}: FORCE-START (30s warmup elapsed)`);
                await sendRconCmd('say "Warmup time expired. Starting match!"');
                await sendRconCmd('css_start');

                // Mark match as actually started (for webhook protection)
                await supabase.from('matches').update({
                    match_started_at: new Date().toISOString()
                }).eq('id', match.id);

                warmupState.set(match.id, { ...state, started: true });
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
// 6. PAYOUTS (With Audit Timestamps)
// ---------------------------------------------------------
async function processPayouts(supabase, escrow) {
    const { data: matches } = await supabase.from('matches')
        .select('*').eq('status', 'COMPLETE').eq('payout_status', 'PENDING');

    if (!matches || matches.length === 0) return;

    console.log(`\n💰 [${new Date().toISOString()}] Processing ${matches.length} payout(s)...`);

    for (const match of matches) {
        const now = new Date();
        const matchStarted = match.match_started_at ? new Date(match.match_started_at) : null;
        const matchCreated = new Date(match.created_at);

        // Calculate elapsed times
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

            console.log(`   ⏳ Waiting for confirmation...`);
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

async function resetServer(supabase, matchId) {
    const { data: server } = await supabase.from('game_servers').select('*').eq('current_match_id', matchId).single();
    if (server) {
        console.log(`   Resetting Server ${server.name}`);
        await sendRcon(server.dathost_id, ['css_endmatch', 'host_workshop_map 3344743064']);
        await supabase.from('game_servers').update({ status: 'FREE', current_match_id: null }).eq('id', server.id);
    }
    warmupState.delete(matchId);
    afkState.delete(matchId);
}

// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------
async function main() {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);

    console.log("🤖 Bot Started (v3 - Warmup Director)");

    // Cleanup any orphaned servers from previous crashes
    await cleanupOrphanedServers(supabase);

    while (true) {
        const loopStart = Date.now();
        try {
            await verifyDeposits(supabase, provider);
            await checkTimeouts(supabase, escrow);
            await assignServers(supabase);
            await checkAutoStart(supabase, escrow);  // Pass escrow for AFK refunds
            await checkForfeits(supabase);
            await processPayouts(supabase, escrow);
        } catch (e) {
            console.error("Loop Error:", e);
        }
        await new Promise(r => setTimeout(r, 5000));
    }
}

main();