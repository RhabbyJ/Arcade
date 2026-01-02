const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const path = require('path');
const dotenv = require('dotenv');
const dgram = require('dgram'); // For direct server queries
const dns = require('dns').promises; // For resolving hostnames to IPs

// Load .env or .env.local from current dir
const envLocalPath = path.resolve(__dirname, '.env.local');
const envPath = path.resolve(__dirname, '.env');
const config = { quiet: true };
dotenv.config({ path: envLocalPath, ...config });
dotenv.config({ path: envPath, ...config });

// --- CONFIG ---
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_ADDRESS;
const PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY;
const RPC_URL = "https://sepolia.base.org";

// DatHost Config - ACCEPTS BOTH NAMING CONVENTIONS
const DATHOST_USER = process.env.DATHOST_USERNAME || process.env.DATHOST_USER;
const DATHOST_PASS = process.env.DATHOST_PASSWORD || process.env.DATHOST_PASS;

// USDC Address (for tx verification)
const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS;

// V2 ABI
const ESCROW_ABI = [
    "function distributeWinnings(bytes32 matchId, address winner) external",
    "function refundMatch(bytes32 matchId, address player) external",
    "function matches(bytes32) view returns (address player1, address player2, uint256 pot, bool isComplete, bool isActive)"
];

// --- HELPERS ---
function numericToBytes32(num) {
    const hex = BigInt(num).toString(16);
    return '0x' + hex.padStart(64, '0');
}

// ---------------------------------------------------------
// NEW: DIRECT SERVER QUERY (A2S_INFO)
// Bypasses DatHost API lag to get instant player counts
// Supports both hostnames and IP addresses
// ---------------------------------------------------------
async function queryPlayerCount(host, port) {
    try {
        // Resolve hostname to IP if needed
        let ip = host;
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
            const result = await dns.lookup(host);
            ip = result.address;
        }

        return new Promise((resolve) => {
            const socket = dgram.createSocket('udp4');
            const packet = Buffer.concat([
                Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]), // Header
                Buffer.from([0x54]),                   // T (A2S_INFO)
                Buffer.from('Source Engine Query\0')   // Payload
            ]);

            // Timeout if server doesn't respond in 2s
            const timeout = setTimeout(() => {
                socket.close();
                resolve(0); // Assume 0 on error
            }, 2000);

            socket.on('message', (msg) => {
                clearTimeout(timeout);
                try {
                    // Parse A2S_INFO response
                    let offset = 6;
                    while (msg[offset] !== 0) offset++; // Skip Name
                    offset++;
                    while (msg[offset] !== 0) offset++; // Skip Map
                    offset++;
                    while (msg[offset] !== 0) offset++; // Skip Folder
                    offset++;
                    while (msg[offset] !== 0) offset++; // Skip Game
                    offset++;

                    offset += 2; // Skip ID
                    const players = msg[offset]; // This byte is player count

                    socket.close();
                    resolve(players || 0);
                } catch (e) {
                    socket.close();
                    resolve(0);
                }
            });

            socket.send(packet, 0, packet.length, port, ip, (err) => {
                if (err) {
                    clearTimeout(timeout);
                    socket.close();
                    resolve(0);
                }
            });
        });
    } catch (e) {
        // Console log removed to reduce spam
        return 0;
    }
}

// ---------------------------------------------------------
// 1. VERIFY DEPOSITS (NEW - Bot as Oracle)
// ---------------------------------------------------------
async function verifyDeposits(supabase, provider) {
    // Find matches in DEPOSITING with unverified tx_hashes
    const { data: matches, error } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'DEPOSITING')
        .or('p1_tx_hash.not.is.null,p2_tx_hash.not.is.null');

    if (error || !matches || matches.length === 0) return;

    for (const match of matches) {
        // CRITICAL: Re-fetch status to prevent race condition with cancellation
        const { data: freshMatch } = await supabase
            .from('matches')
            .select('status')
            .eq('id', match.id)
            .single();

        if (!freshMatch || freshMatch.status !== 'DEPOSITING') {
            continue;
        }

        // Verify P1 deposit
        if (match.p1_tx_hash && !match.p1_deposited) {
            const verified = await verifyTransaction(provider, match.p1_tx_hash);
            if (verified) {
                console.log(`✅ P1 Deposit VERIFIED for match ${match.contract_match_id}`);
                await supabase.from('matches').update({ p1_deposited: true }).eq('id', match.id);
            }
        }

        // Verify P2 deposit
        if (match.p2_tx_hash && !match.p2_deposited) {
            const verified = await verifyTransaction(provider, match.p2_tx_hash);
            if (verified) {
                console.log(`✅ P2 Deposit VERIFIED for match ${match.contract_match_id}`);
                await supabase.from('matches').update({ p2_deposited: true }).eq('id', match.id);
            }
        }
    }
}

async function verifyTransaction(provider, txHash) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt && receipt.status === 1) {
            return true;
        }
        return false;
    } catch (e) {
        console.error(`Error verifying tx ${txHash}:`, e.message);
        return false;
    }
}

// ---------------------------------------------------------
// 2. ASSIGN SERVERS (NEW - After Both Deposits)
// ---------------------------------------------------------
async function assignServers(supabase) {
    const { data: matches, error } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'DEPOSITING')
        .eq('p1_deposited', true)
        .eq('p2_deposited', true)
        .is('server_id', null);

    if (error || !matches || matches.length === 0) return;

    for (const match of matches) {
        const { data: freshMatch } = await supabase
            .from('matches')
            .select('status, server_id')
            .eq('id', match.id)
            .single();

        if (!freshMatch || freshMatch.status !== 'DEPOSITING' || freshMatch.server_id) {
            continue;
        }

        console.log(`🎮 Both players deposited for match ${match.contract_match_id}. Assigning server...`);

        // Find a FREE server
        const { data: server, error: findError } = await supabase
            .from('game_servers')
            .select('*')
            .eq('status', 'FREE')
            .limit(1)
            .single();

        if (findError || !server) {
            console.log(`   ⚠️ No free servers available. Will retry next cycle.`);
            continue;
        }

        // Mark server as BUSY
        await supabase
            .from('game_servers')
            .update({
                status: 'BUSY',
                current_match_id: match.id,
                last_heartbeat: new Date().toISOString()
            })
            .eq('id', server.id);

        if (DATHOST_USER && DATHOST_PASS) {
            const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');
            const WORKSHOP_MAP_ID = '3344743064';

            const sendRcon = async (command) => {
                await fetch(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}/console`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: new URLSearchParams({ line: command })
                });
            };

            try {
                await sendRcon('get5_endmatch');
                await sendRcon('css_endmatch');
                await sendRcon(`host_workshop_map ${WORKSHOP_MAP_ID}`);
                await sendRcon('exec 1v1.cfg');

                console.log(`   ⚙️ Server ${server.name} configured with workshop map + 1v1.cfg`);
            } catch (e) {
                console.error("RCON setup error:", e.message);
            }
        }

        // Update match to LIVE
        const { error: liveError } = await supabase
            .from('matches')
            .update({
                status: 'LIVE',
                server_assigned_at: new Date().toISOString()
            })
            .eq('id', match.id);

        if (liveError) {
            console.error(`   ❌ Failed to set LIVE status:`, liveError);
        } else {
            console.log(`   🚀 Match ${match.contract_match_id} is now LIVE on ${server.name}`);
        }
    }
}

// ---------------------------------------------------------
// 2B. AUTO-START MATCHES (Check for 2 players, forceready after 60s)
// ---------------------------------------------------------
const pendingForceReady = new Map();
const WARMUP_DELAY_MS = 60 * 1000; // 60 second warmup
const MINIMUM_WAIT_AFTER_LIVE = 30 * 1000; // 30 seconds wait for map load

async function checkAutoStart(supabase) {
    const now = Date.now();

    const { data: liveMatches, error: matchError } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'LIVE')
        .is('match_started_at', null);

    if (matchError) {
        console.log(`   ⚠️ [AutoStart] Query error: ${matchError.message}`);
        return;
    }

    if (!liveMatches || liveMatches.length === 0) return;

    if (!DATHOST_USER || !DATHOST_PASS) {
        console.log(`   ⚠️ [AutoStart] DatHost credentials not configured`);
        return;
    }
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');

    for (const match of liveMatches) {
        // --- FIX 2: PREVENT STALE DATA ON MAP CHANGE ---
        // Ensure the match has been LIVE for at least 30 seconds before checking players.
        // This gives DatHost time to clear the "2 players" from the previous session.
        if (match.server_assigned_at) {
            const assignedAt = new Date(match.server_assigned_at).getTime();
            if (now - assignedAt < MINIMUM_WAIT_AFTER_LIVE) {
                // console.log(`   ⏳ Match ${match.contract_match_id} loading map... (${Math.round((MINIMUM_WAIT_AFTER_LIVE - (now - assignedAt))/1000)}s left)`);
                continue;
            }
        }

        const { data: server, error: serverError } = await supabase
            .from('game_servers')
            .select('dathost_id, name, ip, port')
            .eq('current_match_id', match.id)
            .single();

        if (serverError || !server) {
            console.log(`   ⚠️ [AutoStart] Server lookup failed for match ${match.contract_match_id}`);
            continue;
        }

        try {
            // UDP with API Fallback
            let playerCount = await queryPlayerCount(server.ip, server.port);

            if (playerCount === 0) {
                const statusRes = await fetch(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}`, {
                    headers: { 'Authorization': `Basic ${auth}` }
                });
                const serverInfo = await statusRes.json();
                playerCount = serverInfo.players_online || 0;
            }

            // Helper for RCON
            const sendRcon = async (cmd) => {
                await fetch(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}/console`, {
                    method: 'POST',
                    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ line: cmd })
                });
            };

            // If 2+ players detected
            if (playerCount >= 2) {
                if (!pendingForceReady.has(match.id)) {
                    // --- INITIAL DETECT ---
                    console.log(`   👥 2 players detected on ${server.name} for match ${match.contract_match_id}`);
                    console.log(`   ⏱️ Starting 60-second warmup countdown...`);

                    pendingForceReady.set(match.id, {
                        start: now,
                        alerted30: false,
                        alerted10: false
                    });

                    await sendRcon('say "Both players connected! Match auto-starts in 60 seconds (or type .ready)!"');

                } else {
                    // --- COUNTDOWN LOGIC ---
                    const state = pendingForceReady.get(match.id);
                    const elapsed = now - state.start;
                    const remaining = WARMUP_DELAY_MS - elapsed;

                    // 30 Seconds Remaining Check
                    if (remaining <= 30000 && remaining > 25000 && !state.alerted30) {
                        state.alerted30 = true;
                        pendingForceReady.set(match.id, state);
                        await sendRcon('say "Match starting in 30 seconds..."');
                        console.log(`   📢 30s alert sent for ${match.contract_match_id}`);
                    }

                    // 10 Seconds Remaining Check
                    if (remaining <= 10000 && remaining > 5000 && !state.alerted10) {
                        state.alerted10 = true;
                        pendingForceReady.set(match.id, state);
                        await sendRcon('say "Match starting in 10 seconds!"');
                        console.log(`   📢 10s alert sent for ${match.contract_match_id}`);
                    }

                    // --- TIME UP: FORCE START ---
                    if (elapsed >= WARMUP_DELAY_MS) {
                        console.log(`   🚀 60s warmup complete! Sending css_start for match ${match.contract_match_id}`);

                        // --- FIX 1: CORRECT COMMAND ---
                        await sendRcon('css_start'); // MatchZy .start command

                        await supabase.from('matches').update({
                            match_started_at: new Date().toISOString()
                        }).eq('id', match.id);

                        pendingForceReady.delete(match.id);
                        console.log(`   ✅ Match ${match.contract_match_id} is now LIVE and playing!`);
                    }
                }
            } else {
                // Less than 2 players - reset countdown
                if (pendingForceReady.has(match.id)) {
                    console.log(`   ⚠️ Player left, resetting warmup countdown for match ${match.contract_match_id}`);
                    pendingForceReady.delete(match.id);
                }
            }
        } catch (e) {
            console.error(`Error checking auto-start for match ${match.contract_match_id}:`, e.message);
        }
    }
}

// ---------------------------------------------------------
// 3. CHECK TIMEOUTS (NEW - Auto-cancel stale matches)
// ---------------------------------------------------------
async function checkTimeouts(supabase, escrow) {
    const now = Date.now();
    const LOBBY_TIMEOUT_MS = 15 * 60 * 1000;    // 15 minutes
    const READY_TIMEOUT_MS = 60 * 1000;         // 60 seconds for ready check
    const DEPOSIT_TIMEOUT_MS = 30 * 1000;       // 30 seconds for testing

    // A. Check stale WAITING/LOBBY matches (no one joined)
    const { data: waitingMatches } = await supabase
        .from('matches')
        .select('*')
        .in('status', ['WAITING', 'LOBBY'])
        .is('ready_started_at', null);

    if (waitingMatches) {
        for (const match of waitingMatches) {
            const createdAt = new Date(match.created_at).getTime();
            if (now - createdAt > LOBBY_TIMEOUT_MS) {
                console.log(`⏰ TIMEOUT: Match ${match.contract_match_id} in LOBBY for >15min. Cancelling.`);
                await supabase.from('matches').update({ status: 'CANCELLED' }).eq('id', match.id);
            }
        }
    }

    // B. Check stale READY CHECK
    const { data: readyCheckMatches } = await supabase
        .from('matches')
        .select('*')
        .in('status', ['LOBBY', 'PENDING'])
        .not('ready_started_at', 'is', null);

    if (readyCheckMatches) {
        for (const match of readyCheckMatches) {
            if (match.p1_ready && match.p2_ready) continue;
            const readyStartedAt = new Date(match.ready_started_at).getTime();
            if (now - readyStartedAt > READY_TIMEOUT_MS) {
                console.log(`⏰ READY CHECK TIMEOUT: Match ${match.contract_match_id} - Players didn't ready up. Kicking P2.`);
                await supabase.from('matches').update({
                    player2_address: null,
                    player2_steam: null,
                    p1_ready: false,
                    p2_ready: false,
                    ready_started_at: null
                }).eq('id', match.id);
            }
        }
    }

    // C. Check stale DEPOSITING matches
    const { data: depositingMatches } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'DEPOSITING');

    if (depositingMatches) {
        for (const match of depositingMatches) {
            const startTime = match.deposit_started_at || match.created_at;
            const startedAt = new Date(startTime).getTime();
            const isStale = now - startedAt > DEPOSIT_TIMEOUT_MS;

            if (!isStale) continue;

            const onlyP1Paid = match.p1_deposited && !match.p2_deposited;
            const onlyP2Paid = match.p2_deposited && !match.p1_deposited;

            if (onlyP1Paid) {
                console.log(`⏰ TIMEOUT: Match ${match.contract_match_id} - P2 ghosted. Refunding P1.`);
                await refundPlayer(supabase, escrow, match, match.player1_address);
            } else if (onlyP2Paid) {
                console.log(`⏰ TIMEOUT: Match ${match.contract_match_id} - P1 ghosted. Refunding P2.`);
                await refundPlayer(supabase, escrow, match, match.player2_address);
            } else if (!match.p1_deposited && !match.p2_deposited) {
                console.log(`⏰ TIMEOUT: Match ${match.contract_match_id} - No deposits. Cancelling.`);
                await supabase.from('matches').update({ status: 'CANCELLED' }).eq('id', match.id);
            }
        }
    }
}

async function refundPlayer(supabase, escrow, match, playerAddress) {
    try {
        console.log(`   🔒 Setting match ${match.contract_match_id} to CANCELLED...`);
        const { error: cancelError } = await supabase
            .from('matches')
            .update({ status: 'CANCELLED' })
            .eq('id', match.id);

        if (cancelError) {
            console.error(`   ❌ Failed to set CANCELLED:`, cancelError);
            return;
        }
        console.log(`   ✅ Match marked CANCELLED.`);

        const matchIdBytes32 = numericToBytes32(match.contract_match_id);
        const contractMatch = await escrow.matches(matchIdBytes32);
        const pot = contractMatch[2];

        if (pot.toString() !== '0') {
            const tx = await escrow.refundMatch(matchIdBytes32, playerAddress);
            console.log(`   Refund TX: ${tx.hash}`);
            await tx.wait();
            console.log(`   Refund confirmed.`);

            await supabase
                .from('matches')
                .update({ payout_status: 'REFUNDED', refund_tx_hash: tx.hash })
                .eq('id', match.id);
        } else {
            await supabase
                .from('matches')
                .update({ payout_status: 'REFUNDED' })
                .eq('id', match.id);
        }

    } catch (e) {
        console.error(`   Refund error for ${match.contract_match_id}:`, e.message);
        await supabase
            .from('matches')
            .update({ status: 'CANCELLED', payout_status: 'REFUND_FAILED' })
            .eq('id', match.id);
    }
}

// ---------------------------------------------------------
// 4. FORFEIT MONITOR
// ---------------------------------------------------------
async function checkForfeits(supabase) {
    const { data: matches } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'LIVE');

    if (error || !matches || matches.length === 0) return;

    const disconnectMatches = matches.filter(m => m.player1_disconnect_time || m.player2_disconnect_time);
    if (disconnectMatches.length === 0) return;

    const FORFEIT_TIMEOUT_MS = 5 * 60 * 1000;
    const now = Date.now();

    for (const match of disconnectMatches) {
        let winnerAddress = null;
        let disconnectTime = 0;

        if (match.player1_disconnect_time) {
            disconnectTime = new Date(match.player1_disconnect_time).getTime();
            if (now - disconnectTime > FORFEIT_TIMEOUT_MS) {
                winnerAddress = match.player2_address;
            }
        } else if (match.player2_disconnect_time) {
            disconnectTime = new Date(match.player2_disconnect_time).getTime();
            if (now - disconnectTime > FORFEIT_TIMEOUT_MS) {
                winnerAddress = match.player1_address;
            }
        }

        if (winnerAddress) {
            console.log(`🚨 AUTO-FORFEIT Match ${match.contract_match_id} | Winner: ${winnerAddress}`);
            await supabase.from('matches').update({
                status: 'COMPLETE',
                winner_address: winnerAddress,
                payout_status: 'PENDING'
            }).eq('id', match.id);

            await resetServer(supabase, match.id);
        }
    }
}

async function resetServer(supabase, matchId) {
    const { data: server } = await supabase
        .from('game_servers')
        .select('*')
        .eq('current_match_id', matchId)
        .single();

    if (!server || !DATHOST_USER || !DATHOST_PASS) return;

    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');
    const cmds = ['kickall', 'css_endmatch'];

    for (const cmd of cmds) {
        try {
            await fetch(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}/console`, {
                method: 'POST',
                headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ line: cmd }).toString()
            });
        } catch (e) {
            console.error("RCON Error:", e.message);
        }
    }

    await supabase.from('game_servers').update({ status: 'FREE', current_match_id: null }).eq('id', server.id);
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

    console.log(`💰 Found ${matches.length} pending payouts.`);

    for (const match of matches) {
        const matchIdBytes32 = numericToBytes32(match.contract_match_id);
        const winner = match.winner_address;

        console.log(`   Paying Match ${match.contract_match_id}... -> ${winner}`);

        try {
            await supabase.from('matches').update({ payout_status: 'PROCESSING' }).eq('id', match.id);
            const tx = await escrow.distributeWinnings(matchIdBytes32, winner);
            console.log(`   Tx Sent: ${tx.hash}`);
            await tx.wait();
            console.log("   Tx Confirmed!");
            await supabase.from('matches').update({ payout_status: 'PAID' }).eq('id', match.id);
        } catch (e) {
            console.error(`   FAILED payout ${match.contract_match_id}:`, e.message);
            await supabase.from('matches').update({ payout_status: 'FAILED' }).eq('id', match.id);
        }
    }
}

// ---------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------
async function run() {
    if (!PRIVATE_KEY) {
        console.error("ERROR: PAYOUT_PRIVATE_KEY not found in .env");
        process.exit(1);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);

    console.log(`[${new Date().toISOString()}] Bot cycle starting...`);

    try {
        await verifyDeposits(supabase, provider);
        await assignServers(supabase);
        await checkAutoStart(supabase); // <--- Updated with new logic
        await checkTimeouts(supabase, escrow);
        // await checkForfeits(supabase); 
        await processPayouts(supabase, escrow);
    } catch (e) {
        console.error("Loop Error:", e);
    }
}

run();
setInterval(run, 5000);