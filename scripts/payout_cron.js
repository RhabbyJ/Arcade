const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const path = require('path');
const dotenv = require('dotenv');
const dgram = require('dgram'); // For direct server queries
const dns = require('dns').promises; // For resolving hostnames to IPs

// DNS Cache (for DatHost hostnames)
const dnsCache = new Map();
const DNS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DNS_LOOKUP_TIMEOUT_MS = 2000; // 2 seconds

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
const GOTV_MASTER = process.env.GOTV_MASTER || process.env.TV_MASTER;
const MATCHZY_BACKUP_UPLOAD_URL = process.env.MATCHZY_BACKUP_UPLOAD_URL || process.env.MATCHZY_FILEUPLOAD_URL;
const OPS_ALERT_WEBHOOK = process.env.OPS_ALERT_WEBHOOK || process.env.OPS_ALERT_URL;

// USDC Address (for tx verification)
const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS;

// V2 ABI
const ESCROW_ABI = [
    "function distributeWinnings(bytes32 matchId, address winner) external",
    "function refundMatch(bytes32 matchId, address player) external",
    "function matches(bytes32) view returns (address player1, address player2, uint256 pot, bool isComplete, bool isActive)"
];

// Zero-player safety nets
const ZERO_PLAYER_POLL_THRESHOLD = Number(process.env.ZERO_PLAYER_POLL_THRESHOLD || 6);
const ZERO_PLAYER_MAX_WINDOW_MS = Number(process.env.ZERO_PLAYER_MAX_WINDOW_MS || 3 * 60 * 1000); // 3 minutes
const ZERO_PLAYER_EXTENSION_MS = Number(process.env.ZERO_PLAYER_EXTENSION_MS || 60 * 1000); // 1 minute

// --- HELPERS ---
function numericToBytes32(num) {
    const hex = BigInt(num).toString(16);
    return '0x' + hex.padStart(64, '0');
}

const gotvInitAttempts = new Map();
let backupsWarningShown = false;

/**
 * CRITICAL FIX: Wrapper for fetch to prevent bot freezing
 * If DatHost doesn't respond in 5 seconds, this throws an error so the loop continues.
 */
async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 5000 } = options; // 5 second default timeout
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// Send a lightweight webhook to ops (Slack/Discord compatible JSON payload)
async function notifyOps(message, context = {}) {
    console.log(message);

    if (!OPS_ALERT_WEBHOOK) return;

    try {
        function extractSteamIds(serverInfo) {
            const steamIds = new Set();
            const candidates = Array.isArray(serverInfo?.players)
                ? serverInfo.players
                : Array.isArray(serverInfo?.connected_players)
                    ? serverInfo.connected_players
                    : [];

            for (const player of candidates) {
                if (player?.steam_id) {
                    steamIds.add(String(player.steam_id));
                }
            }

            return steamIds;
        }
        await fetchWithTimeout(OPS_ALERT_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: message, ...context })
        });
    } catch (e) {
        console.log(`   ⚠️ Ops webhook failed: ${e.message}`);
    }
}

const zeroPlayerState = new Map();


function logDnsEvent(type, details) {
    console.log(JSON.stringify({
        event: 'dns_resolution',
        type,
        ...details
    }));
}

async function resolveHostnameWithCache(host) {
    // If already an IP, return as-is
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        return host;
    }

    const now = Date.now();
    const cached = dnsCache.get(host);

    if (cached && cached.address && now < cached.expiresAt) {
        logDnsEvent('cache_hit', { host, address: cached.address, expiresAt: cached.expiresAt });
        return cached.address;
    }

    const lastKnown = cached?.address || cached?.lastKnown;

    try {
        const lookupPromise = dns.lookup(host);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('DNS lookup timeout')), DNS_LOOKUP_TIMEOUT_MS));
        const result = await Promise.race([lookupPromise, timeoutPromise]);
        const address = result.address || result;

        dnsCache.set(host, { address, expiresAt: now + DNS_CACHE_TTL_MS, lastKnown: address });
        logDnsEvent('fresh_lookup', { host, address, expiresAt: now + DNS_CACHE_TTL_MS });
        return address;
    } catch (err) {
        if (err.message === 'DNS lookup timeout') {
            logDnsEvent('timeout_fallback', { host, lastKnown });
        } else {
            logDnsEvent('lookup_failed', { host, error: err.message, lastKnown });
        }

        if (lastKnown) {
            dnsCache.set(host, { address: lastKnown, expiresAt: now + DNS_CACHE_TTL_MS, lastKnown });
            return lastKnown;
        }

        throw err;
    }
}

// ---------------------------------------------------------
// NEW: DIRECT SERVER QUERY (A2S_INFO)
// Bypasses DatHost API lag to get instant player counts
// Supports both hostnames and IP addresses
// ---------------------------------------------------------
async function queryPlayerCount(host, port) {
    try {
        // Resolve hostname to IP if needed
        const ip = await resolveHostnameWithCache(host);


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
            const configState = ensureConfigState(match.id);

            const sendRcon = async (command) => {
                try {
                    await fetchWithTimeout(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}/console`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Basic ${auth}`,
                            'Content-Type': 'application/x-www-form-urlencoded'
                        },
                        body: new URLSearchParams({ line: command })
                    });
                } catch (e) {
                    console.log(`   ❌ RCON timeout: ${command}`);
                }
            };

            try {
                await sendRcon('get5_endmatch');
                await sendRcon('css_endmatch');
                await sendRcon(`host_workshop_map ${WORKSHOP_MAP_ID}`);
                await sendRcon(`tv_enable 1; tv_autorecord 1; tv_snapshotrate 64; tv_maxclients 10${GOTV_MASTER ? `; tv_master ${GOTV_MASTER}` : ''}`);

                if (MATCHZY_BACKUP_UPLOAD_URL) {
                    await sendRcon(`matchzy_backups_enabled true; matchzy_backups_fileupload_url "${MATCHZY_BACKUP_UPLOAD_URL}"`);
                    console.log('   🗂️ MatchZy backup upload URL configured.');
                } else {
                    await sendRcon('matchzy_backups_enabled false');
                    if (!backupsWarningShown) {
                        console.log('   ⚠️ MatchZy backup uploads disabled: MATCHZY_BACKUP_UPLOAD_URL not set.');
                        backupsWarningShown = true;
                    }
                }
                console.log(`   ⚙️ Server ${server.name} loading workshop map ${WORKSHOP_MAP_ID}`);
                await sendRcon('exec 1v1.cfg');
                console.log(`   ⚙️ Server ${server.name} applied 1v1.cfg at map start`);


                await new Promise((resolve) => setTimeout(resolve, MAP_LOAD_WARMUP_DELAY_MS));

                if (!configState.warmup) {
                    await sendRcon('exec MatchZy/warmup.cfg');
                    configState.warmup = true;
                    console.log(`   🔥 Server ${server.name} applied MatchZy/warmup.cfg after map load delay (${MAP_LOAD_WARMUP_DELAY_MS}ms)`);
                }
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
// 2B. AUTO-START MATCHES (Dynamic Warmup Logic)
// ---------------------------------------------------------
// State machine: WAITING_P2 (1 player, 2 min timer) -> READY_COUNTDOWN (2 players, 30s timer)
// If P2 doesn't join within 2 mins, match is cancelled
const pendingForceReady = new Map();
const configApplied = new Map(); // Tracks warmup/live cfg execution per match
const matchMetrics = new Map();
const pollSchedules = new Map();
const WARMUP_DELAY_P1 = 120 * 1000; // 2 minutes for P2 to join
const WARMUP_DELAY_P2 = 30 * 1000;  // 30 seconds when both players are in
const MAP_LOAD_WARMUP_DELAY_MS = 3000; // Delay after map load before warmup cfg
const MINIMUM_WAIT_AFTER_LIVE = 15 * 1000; // 15 seconds wait for map load + API update
const POST_LIVE_WARMUP_DELAY = 20 * 1000; // 20 seconds wait for map load + API update
const INITIAL_POLL_BACKOFF = 5 * 1000;
const MAX_POLL_BACKOFF = 60 * 1000;
const readyStartLog = new Set();

function extractSteamIds(serverInfo) {
    const steamIds = new Set();
    const candidates = Array.isArray(serverInfo?.players)
        ? serverInfo.players
        : Array.isArray(serverInfo?.connected_players)
            ? serverInfo.connected_players
            : [];

    for (const player of candidates) {
        if (player?.steam_id) {
            steamIds.add(String(player.steam_id));
        }
    }

    return steamIds;
}

function ensureConfigState(matchId) {
    if (!configApplied.has(matchId)) {
        configApplied.set(matchId, { warmup: false, live: false });
    }
    return configApplied.get(matchId);
}


// Poll DatHost with a small backoff to stabilize player counts
async function pollPlayerCountWithBackoff(server, auth) {
    const snapshots = [];
    const delays = [0, 500, 1000];

    for (const delay of delays) {
        if (delay > 0) await new Promise(res => setTimeout(res, delay));

        const udpCount = await queryPlayerCount(server.ip, server.port);
        let apiCount = 0;

        try {
            const statusRes = await fetchWithTimeout(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}`, {
                headers: { 'Authorization': `Basic ${auth}` }
            });
            if (statusRes.ok) {
                const serverInfo = await statusRes.json();
                apiCount = serverInfo.players_online || 0;
            }
        } catch (err) {
            // Suppress noisy logs here; handled by outer caller when needed
        }

        snapshots.push({
            delay,
            udpCount,
            apiCount,
            maxCount: Math.max(udpCount || 0, apiCount || 0)
        });
    }

    const bestCount = snapshots.reduce((max, snap) => Math.max(max, snap.maxCount), 0);
    return { bestCount, snapshots };
}

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

    console.log(`   🔍 [AutoStart] Found ${liveMatches.length} LIVE match(es) awaiting warmup`);

    if (!DATHOST_USER || !DATHOST_PASS) {
        console.log(`   ⚠️ [AutoStart] DatHost credentials not configured`);
        return;
    }
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');

    for (const match of liveMatches) {
        // Track metrics per match
        if (!matchMetrics.has(match.id)) {
            matchMetrics.set(match.id, {
                mapChangeAt: match.server_assigned_at ? new Date(match.server_assigned_at).getTime() : now,
                delayLogged: false,
                firstPlayerAt: null,
                firstNonZeroAt: null,
                warmupStartedAt: null
            });
        }
        const metrics = matchMetrics.get(match.id);

        // Wait a few seconds after server assignment for map to load
        if (match.server_assigned_at) {
            const assignedAt = new Date(match.server_assigned_at).getTime();
            const waitRemaining = MINIMUM_WAIT_AFTER_LIVE - (now - assignedAt);

            if (!metrics.delayLogged) {
                console.log(`   🗺️ Match ${match.contract_match_id}: Map changed ${Math.round((now - assignedAt) / 1000)}s ago. Using ${MINIMUM_WAIT_AFTER_LIVE / 1000}s post-live delay before polling player count.`);
                metrics.delayLogged = true;
            }

            if (waitRemaining > 0) {
                console.log(`   ⏳ Match ${match.contract_match_id}: Waiting for map to load (${Math.ceil(waitRemaining / 1000)}s left)`);
                continue;
            }
        }

        let server;
        try {
            const { data, error } = await supabase
                .from('game_servers')
                .select('dathost_id, name, ip, port')
                .eq('current_match_id', match.id)
                .single();

            if (error) {
                console.log(`   ⚠️ Match ${match.contract_match_id}: Server query error: ${error.message}`);
                continue;
            }
            server = data;
        } catch (e) {
            console.log(`   ❌ Match ${match.contract_match_id}: Server query failed: ${e.message}`);
            continue;
        }

        if (!server) {
            console.log(`   ⚠️ Match ${match.contract_match_id}: No server assigned`);
            continue;
        }

        // Guard: ensure players are connected before honoring .ready triggers
        const readyRequested = match.p1_ready && match.p2_ready;
        const debounceMs = 1500;
        try {
            const schedule = pollSchedules.get(match.id) || { backoffMs: INITIAL_POLL_BACKOFF, nextPollAt: 0 };
            if (now < schedule.nextPollAt) {
                console.log(`   ⏳ Match ${match.contract_match_id}: Skipping poll for ${Math.ceil((schedule.nextPollAt - now) / 1000)}s (backoff ${schedule.backoffMs / 1000}s)`);
                pollSchedules.set(match.id, schedule);
                continue;
            }

            console.log(`   🔎 Match ${match.contract_match_id}: Checking player count via DatHost API...`);

            // Use DatHost API directly (UDP/dns.lookup can freeze)
            let playerCount = 0;
            let serverInfo = null;
            let mapReady = false;
            try {
                const statusRes = await fetchWithTimeout(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}`, {
                    headers: { 'Authorization': `Basic ${auth}` }
                });
                if (statusRes.ok) {
                    serverInfo = await statusRes.json();
                    const serverState = (serverInfo.state || serverInfo.status || '').toL// GOTV must be ready before we start the demo/recording.
                    const gotvOnline = serverInfo?.gotv_online ?? serverInfo?.gotv_running ?? serverInfo?.gotv?.online ?? serverInfo?.gotv?.is_online ?? null;
                    const gotvEnabled = serverInfo?.gotv_enabled ?? serverInfo?.gotv?.enabled ?? null;

                    if (gotvOnline === false || gotvEnabled === false) {
                        console.log(`   ⚠️ Match ${match.contract_match_id}: GOTV offline. Enabling before start.`);
                        await sendRcon(`tv_enable 1; tv_autorecord 1; tv_snapshotrate 64; tv_maxclients 10${GOTV_MASTER ? `; tv_master ${GOTV_MASTER}` : ''}`);
                        gotvInitAttempts.set(match.id, 1);
                        continue;
                    }

                    if (gotvOnline === null) {
                        const attempts = gotvInitAttempts.get(match.id) || 0;
                        if (attempts < 2) {
                            console.log(`   ⚠️ Match ${match.contract_match_id}: GOTV status unknown. Ensuring it is enabled before forcing start.`);
                            await sendRcon(`tv_enable 1; tv_autorecord 1; tv_snapshotrate 64; tv_maxclients 10${GOTV_MASTER ? `; tv_master ${GOTV_MASTER}` : ''}`);
                            gotvInitAttempts.set(match.id, attempts + 1);
                            continue;
                        }
                    } else if (gotvOnline === true) {
                        gotvInitAttempts.delete(match.id);
                    }
                    owerCase();
                    mapReady = ['started', 'running', 'on', 'ready'].includes(serverState);
                    playerCount = serverInfo.players_online || 0;
                    console.log(`   🛰️ Match ${match.contract_match_id}: DatHost state='${serverState || 'unknown'}', mapReady=${mapReady}`);
                } else {
                    console.log(`   ⚠️ Match ${match.contract_match_id}: API returned ${statusRes.status}`);
                }

            } catch (apiErr) {
                console.log(`   ⚠️ Match ${match.contract_match_id}: API failed: ${apiErr.message}`);
            }

            const steamIds = serverInfo ? extractSteamIds(serverInfo) : new Set();
            const matchState = zeroPlayerState.get(match.id) || {
                zeroCount: 0,
                zeroStart: null,
                lastPresence: null,
                lastSeenSteamIds: new Set()
            };

            if (steamIds.size > 0) {
                matchState.lastPresence = now;
                matchState.lastSeenSteamIds = steamIds;
                matchState.zeroCount = 0;
                matchState.zeroStart = null;
            }

            if (playerCount === 0) {
                matchState.zeroCount += 1;
                if (!matchState.zeroStart) {
                    matchState.zeroStart = now;
                }

                if (matchState.zeroCount >= ZERO_PLAYER_POLL_THRESHOLD) {
                    let confirmedCount = 0;
                    let confirmedSteamIds = new Set();

                    try {
                        const confirmRes = await fetchWithTimeout(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}`, {
                            headers: { 'Authorization': `Basic ${auth}` }
                        });

                        if (confirmRes.ok) {
                            const confirmInfo = await confirmRes.json();
                            confirmedCount = confirmInfo.players_online || 0;
                            confirmedSteamIds = extractSteamIds(confirmInfo);
                        }
                    } catch (confirmErr) {
                        console.log(`   ⚠️ Match ${match.contract_match_id}: Confirm poll failed: ${confirmErr.message}`);
                    }

                    if (confirmedCount === 0) {
                        const presenceSeen = steamIds.size > 0 || matchState.lastSeenSteamIds.size > 0 || matchState.lastPresence;

                        if (presenceSeen) {
                            const mergedSteamIds = new Set([
                                ...matchState.lastSeenSteamIds,
                                ...steamIds,
                                ...confirmedSteamIds
                            ]);

                            matchState.lastSeenSteamIds = mergedSteamIds;
                            matchState.zeroCount = 0;
                            matchState.zeroStart = now + ZERO_PLAYER_EXTENSION_MS;

                            await notifyOps(`   🚨 Match ${match.contract_match_id}: Zero players detected after prior connections on ${server.name}. Extending wait.`, {
                                matchId: match.contract_match_id,
                                steamIds: Array.from(mergedSteamIds),
                                server: server.name,
                                event: 'zero_player_extend'
                            });
                        } else if (now - matchState.zeroStart >= ZERO_PLAYER_MAX_WINDOW_MS) {
                            console.log(`   ⏰ Match ${match.contract_match_id}: No player presence for ${Math.round(ZERO_PLAYER_MAX_WINDOW_MS / 1000)}s. Cancelling.`);

                            await notifyOps(`   ⏰ Match ${match.contract_match_id}: No player presence detected on ${server.name}. Cancelling to recycle server.`, {
                                matchId: match.contract_match_id,
                                server: server.name,
                                event: 'zero_player_cancel'
                            });

                            await supabase.from('matches').update({
                                status: 'CANCELLED',
                                payout_status: 'REFUND_PENDING'
                            }).eq('id', match.id);

                            await supabase.from('game_servers').update({
                                status: 'FREE',
                                current_match_id: null
                            }).eq('current_match_id', match.id);

                            pendingForceReady.delete(match.id);
                            zeroPlayerState.delete(match.id);
                            continue;
                        }
                    } else {
                        playerCount = confirmedCount;

                        if (confirmedSteamIds.size > 0) {
                            matchState.lastPresence = now;
                            matchState.lastSeenSteamIds = confirmedSteamIds;
                        }

                        matchState.zeroCount = 0;
                        matchState.zeroStart = null;
                    }
                }
            } else {
                matchState.zeroCount = 0;
                matchState.zeroStart = null;
            }

            zeroPlayerState.set(match.id, matchState);

            if (!mapReady) {
                schedule.backoffMs = Math.min(schedule.backoffMs * 2, MAX_POLL_BACKOFF);
                schedule.nextPollAt = now + schedule.backoffMs;
                pollSchedules.set(match.id, schedule);
                console.log(`   💤 Match ${match.contract_match_id}: Map not ready, backing off player poll to ${schedule.backoffMs / 1000}s.`);
                continue;
            }

            schedule.backoffMs = INITIAL_POLL_BACKOFF;
            schedule.nextPollAt = now + schedule.backoffMs;
            pollSchedules.set(match.id, schedule);

            if (!metrics.firstNonZeroAt && playerCount > 0) {
                metrics.firstNonZeroAt = now;
                console.log(`   ⏱️ Match ${match.contract_match_id}: First non-zero player count detected ${Math.round((now - metrics.mapChangeAt) / 1000)}s after map change.`);
            }
            if (!metrics.firstPlayerAt && playerCount >= 1) {
                metrics.firstPlayerAt = now;
                console.log(`   👟 Match ${match.contract_match_id}: First player connection detected ${Math.round((now - metrics.mapChangeAt) / 1000)}s after map change.`);
            }

            console.log(`   📊 Match ${match.contract_match_id}: ${playerCount} player(s) detected`);

            // RCON Helper with logging
            const sendRcon = async (cmd) => {
                const lines = cmd.split(';');
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) continue;
                    console.log(`   📡 RCON → ${trimmedLine}`);
                    try {
                        await fetchWithTimeout(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}/console`, {
                            method: 'POST',
                            headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: new URLSearchParams({ line: trimmedLine })
                        });
                    } catch (e) {
                        console.log(`   ❌ RCON timeout: ${trimmedLine}`);
                    }
                }
            };

            // If both players signaled .ready, double-check connectivity with a debounced poll before force-starting
            if (readyRequested && !readyStartLog.has(match.id)) {
                const initialPoll = await pollPlayerCountWithBackoff(server, auth);
                await new Promise(res => setTimeout(res, debounceMs));
                const debouncePoll = await pollPlayerCountWithBackoff(server, auth);

                const combinedMax = Math.max(initialPoll.bestCount, debouncePoll.bestCount);

                if (combinedMax >= 2) {
                    readyStartLog.add(match.id);
                    console.log(`   🟢 .ready live trigger for match ${match.contract_match_id} | counts=${JSON.stringify({ initial: initialPoll.snapshots, debounce: debouncePoll.snapshots })}`);

                    if (!configState.live) {
                        await sendRcon('exec MatchZy/live.cfg');
                        configState.live = true;
                        console.log(`   🟢 Match ${match.contract_match_id}: MatchZy/live.cfg applied before live start`);
                    }

                    await sendRcon('css_start');

                    await supabase.from('matches')
                        .update({ match_started_at: new Date().toISOString() })
                        .eq('id', match.id);

                    pendingForceReady.delete(match.id);
                    continue;
                }
            }

            const configState = ensureConfigState(match.id);
            const currentState = pendingForceReady.get(match.id);

            // GOTV must be ready before we start the demo/recording.
            const gotvOnline = serverInfo?.gotv_online ?? serverInfo?.gotv_running ?? serverInfo?.gotv?.online ?? serverInfo?.gotv?.is_online ?? null;
            const gotvEnabled = serverInfo?.gotv_enabled ?? serverInfo?.gotv?.enabled ?? null;

            if (gotvOnline === false || gotvEnabled === false) {
                console.log(`   ⚠️ Match ${match.contract_match_id}: GOTV offline. Enabling before start.`);
                await sendRcon(`tv_enable 1; tv_autorecord 1; tv_snapshotrate 64; tv_maxclients 10${GOTV_MASTER ? `; tv_master ${GOTV_MASTER}` : ''}`);
                gotvInitAttempts.set(match.id, 1);
                continue;
            }

            if (gotvOnline === null) {
                const attempts = gotvInitAttempts.get(match.id) || 0;
                if (attempts < 2) {
                    console.log(`   ⚠️ Match ${match.contract_match_id}: GOTV status unknown. Ensuring it is enabled before forcing start.`);
                    await sendRcon(`tv_enable 1; tv_autorecord 1; tv_snapshotrate 64; tv_maxclients 10${GOTV_MASTER ? `; tv_master ${GOTV_MASTER}` : ''}`);
                    gotvInitAttempts.set(match.id, attempts + 1);
                    continue;
                }
            } else if (gotvOnline === true) {
                gotvInitAttempts.delete(match.id);
            }


            // ========== STATE: 1 PLAYER (WAITING FOR P2) ==========
            if (playerCount === 1) {
                if (!currentState || currentState.state !== 'WAITING_P2') {
                    // First detection of 1 player
                    console.log(`   👤 Match ${match.contract_match_id}: 1 player joined. Starting 2-min countdown for P2.`);
                    pendingForceReady.set(match.id, { state: 'WAITING_P2', start: now });

                    metrics.warmupStartedAt = metrics.warmupStartedAt || now;
                    await sendRcon('mp_warmuptime 120');
                    await sendRcon('mp_warmup_start');
                    await sendRcon('say "Waiting for opponent... 2 minutes remaining. Type .ready when ready!"');
                    console.log(`   🔥 Match ${match.contract_match_id}: Warmup started ${Math.round((metrics.warmupStartedAt - metrics.mapChangeAt) / 1000)}s after map change.`);
                } else {
                    // Check if P1 timeout expired (P2 never joined)
                    const elapsed = now - currentState.start;
                    if (elapsed >= WARMUP_DELAY_P1) {
                        console.log(`   ⏰ Match ${match.contract_match_id}: P2 never joined. Cancelling match.`);

                        await sendRcon('say "Opponent did not join in time. Match cancelled."');
                        await sendRcon('kickall');

                        // Cancel the match in database
                        await supabase.from('matches').update({
                            status: 'CANCELLED',
                            payout_status: 'REFUND_PENDING'
                        }).eq('id', match.id);

                        // Free the server
                        await supabase.from('game_servers').update({
                            status: 'FREE',
                            current_match_id: null
                        }).eq('current_match_id', match.id);

                        pendingForceReady.delete(match.id);
                    }
                }
            }
            // ========== STATE: 2 PLAYERS (READY COUNTDOWN) ==========
            else if (playerCount >= 2) {
                if (!currentState || currentState.state !== 'READY_COUNTDOWN') {
                    // Both players joined - accelerate to 30s
                    console.log(`   👥 Match ${match.contract_match_id}: Both players connected! 30s countdown started.`);
                    pendingForceReady.set(match.id, { state: 'READY_COUNTDOWN', start: now });

                    metrics.warmupStartedAt = metrics.warmupStartedAt || now;
                    await sendRcon('mp_warmuptime 30');
                    await sendRcon('mp_warmup_start');
                    await sendRcon('say "Both players connected! Match starts in 30 seconds. Type .ready to start now!"');
                    console.log(`   🔥 Match ${match.contract_match_id}: Warmup started ${Math.round((metrics.warmupStartedAt - metrics.mapChangeAt) / 1000)}s after map change.`);
                } else {
                    // Check if 30s expired
                    const elapsed = now - currentState.start;
                    if (elapsed >= WARMUP_DELAY_P2) {
                        console.log(`   🚀 Match ${match.contract_match_id}: 30s warmup complete. Force-starting match!`);

                        // Set 1-round match settings before starting
                        await sendRcon('mp_maxrounds 1');
                        await sendRcon('mp_winlimit 1');
                        await sendRcon('mp_halftime 0');
                        await sendRcon('mp_overtime_enable 0');
                        await sendRcon('css_start');

                        await supabase.from('matches').update({
                            match_started_at: new Date().toISOString()
                        }).eq('id', match.id);

                        pendingForceReady.delete(match.id);
                        console.log(`   ✅ Match ${match.contract_match_id} is now LIVE!`);
                    }
                }
            }
            // ========== STATE: 0 PLAYERS (EMPTY) ==========
            else {
                if (currentState) {
                    console.log(`   ⚠️ Match ${match.contract_match_id}: All players left. Resetting state.`);
                    pendingForceReady.delete(match.id);
                }
            }


        } catch (e) {
            console.error(`   ❌ Error in checkAutoStart for match ${match.contract_match_id}:`, e.message);
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