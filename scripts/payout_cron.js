const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const path = require('path');
const dotenv = require('dotenv');
const dgram = require('dgram');
const dns = require('dns').promises;

// Load env vars
const envLocalPath = path.resolve(__dirname, '.env.local');
const envPath = path.resolve(__dirname, '.env');
const config = { quiet: true };
dotenv.config({ path: envLocalPath, ...config });
dotenv.config({ path: envPath, ...config });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_ADDRESS;
const PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY;
const RPC_URL = "https://sepolia.base.org";

const DATHOST_USER = process.env.DATHOST_USERNAME || process.env.DATHOST_USER;
const DATHOST_PASS = process.env.DATHOST_PASSWORD || process.env.DATHOST_PASS;
const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS;

const ESCROW_ABI = [
    "function distributeWinnings(bytes32 matchId, address winner) external",
    "function refundMatch(bytes32 matchId, address player) external",
    "function matches(bytes32) view returns (address player1, address player2, uint256 pot, bool isComplete, bool isActive)"
];

function numericToBytes32(num) {
    const hex = BigInt(num).toString(16);
    return '0x' + hex.padStart(64, '0');
}

// --- NETWORK HELPERS ---

// 1. Fetch with Timeout (Prevents HTTP hangs)
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

// 2. DNS Cache (Prevents spamming DNS lookups)
const dnsCache = new Map(); // hostname -> { ip, expires }

async function resolveHostname(host) {
    // Return IP if it's already an IP
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;

    // Check Cache
    const now = Date.now();
    if (dnsCache.has(host)) {
        const cached = dnsCache.get(host);
        if (now < cached.expires) return cached.ip;
    }

    // Perform Lookup with Timeout
    try {
        const lookupPromise = dns.lookup(host);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("DNS Timeout")), 2000)
        );

        const result = await Promise.race([lookupPromise, timeoutPromise]);

        // Cache for 5 minutes
        dnsCache.set(host, { ip: result.address, expires: now + 300000 });
        // console.log(`   [DNS] Resolved ${host} -> ${result.address}`);
        return result.address;
    } catch (e) {
        console.error(`   ⚠️ DNS Error for ${host}: ${e.message}`);
        return null; // Return null to signal failure
    }
}

// 3. Robust UDP Query
async function queryPlayerCount(host, port) {
    const ip = await resolveHostname(host);
    if (!ip) return 0; // Skip if DNS failed

    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        const packet = Buffer.concat([
            Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]),
            Buffer.from([0x54]),
            Buffer.from('Source Engine Query\0')
        ]);

        const timeout = setTimeout(() => {
            socket.close();
            resolve(0); // Fail silently on timeout
        }, 2000);

        socket.on('message', (msg) => {
            clearTimeout(timeout);
            try {
                // Parse A2S_INFO
                let offset = 6;
                while (msg[offset] !== 0) offset++; // Name
                offset++;
                while (msg[offset] !== 0) offset++; // Map
                offset++;
                while (msg[offset] !== 0) offset++; // Folder
                offset++;
                while (msg[offset] !== 0) offset++; // Game
                offset++;
                offset += 2; // ID
                const players = msg[offset];
                socket.close();
                resolve(players || 0);
            } catch (e) {
                socket.close();
                resolve(0);
            }
        });

        socket.on('error', () => {
            clearTimeout(timeout);
            socket.close();
            resolve(0);
        });

        socket.send(packet, 0, packet.length, port, ip, (err) => {
            if (err) {
                clearTimeout(timeout);
                socket.close();
                resolve(0);
            }
        });
    });
}

// ---------------------------------------------------------
// LOGIC BLOCKS
// ---------------------------------------------------------

async function verifyDeposits(supabase, provider) {
    const { data: matches, error } = await supabase
        .from('matches').select('*').eq('status', 'DEPOSITING')
        .or('p1_tx_hash.not.is.null,p2_tx_hash.not.is.null');

    if (error || !matches || matches.length === 0) return;

    for (const match of matches) {
        const { data: freshMatch } = await supabase.from('matches').select('status').eq('id', match.id).single();
        if (!freshMatch || freshMatch.status !== 'DEPOSITING') continue;

        const verifyTx = async (txHash) => {
            try {
                const receipt = await provider.getTransactionReceipt(txHash);
                return receipt && receipt.status === 1;
            } catch (e) { return false; }
        };

        if (match.p1_tx_hash && !match.p1_deposited && await verifyTx(match.p1_tx_hash)) {
            console.log(`✅ P1 Deposit VERIFIED for match ${match.contract_match_id}`);
            await supabase.from('matches').update({ p1_deposited: true }).eq('id', match.id);
        }
        if (match.p2_tx_hash && !match.p2_deposited && await verifyTx(match.p2_tx_hash)) {
            console.log(`✅ P2 Deposit VERIFIED for match ${match.contract_match_id}`);
            await supabase.from('matches').update({ p2_deposited: true }).eq('id', match.id);
        }
    }
}

async function assignServers(supabase) {
    const { data: matches } = await supabase.from('matches').select('*')
        .eq('status', 'DEPOSITING').eq('p1_deposited', true).eq('p2_deposited', true).is('server_id', null);

    if (!matches || matches.length === 0) return;

    for (const match of matches) {
        const { data: fresh } = await supabase.from('matches').select('status, server_id').eq('id', match.id).single();
        if (!fresh || fresh.status !== 'DEPOSITING' || fresh.server_id) continue;

        console.log(`🎮 Assigning server for match ${match.contract_match_id}...`);
        const { data: server } = await supabase.from('game_servers').select('*').eq('status', 'FREE').limit(1).single();

        if (!server) {
            console.log(`   ⚠️ No free servers available.`);
            continue;
        }

        await supabase.from('game_servers').update({ status: 'BUSY', current_match_id: match.id, last_heartbeat: new Date().toISOString() }).eq('id', server.id);

        if (DATHOST_USER && DATHOST_PASS) {
            const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');
            const sendRcon = async (command) => {
                try {
                    await fetchWithTimeout(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}/console`, {
                        method: 'POST',
                        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({ line: command })
                    });
                } catch (e) { console.error(`   ❌ RCON failed: ${e.message}`); }
            };

            await sendRcon('get5_endmatch');
            await sendRcon('css_endmatch');
            await sendRcon('host_workshop_map 3344743064');
            await sendRcon('exec 1v1.cfg');
            console.log(`   ⚙️ Server ${server.name} configured.`);
        }

        const { error: liveError } = await supabase.from('matches')
            .update({ status: 'LIVE', server_assigned_at: new Date().toISOString() }).eq('id', match.id);

        if (!liveError) console.log(`   🚀 Match ${match.contract_match_id} is now LIVE!`);
    }
}

// --- AUTO START LOGIC ---
// Native CS2 CVars handle warmup (mp_warmuptime_all_players_connected)
// Bot only handles: 1) AFK cancellation when P2 doesn't show up
const afkState = new Map(); // match.id -> { start: timestamp }
const AFK_TIMEOUT_MS = 120 * 1000; // 2 minutes to cancel if P2 never joins
const MINIMUM_WAIT_AFTER_LIVE = 15 * 1000;

async function checkAutoStart(supabase) {
    const now = Date.now();
    const { data: liveMatches } = await supabase.from('matches').select('*').eq('status', 'LIVE').is('match_started_at', null);

    if (!liveMatches || liveMatches.length === 0) return;
    if (!DATHOST_USER || !DATHOST_PASS) return;
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');

    for (const match of liveMatches) {
        // Wait for map to load
        if (match.server_assigned_at && (now - new Date(match.server_assigned_at).getTime() < MINIMUM_WAIT_AFTER_LIVE)) continue;

        const { data: server } = await supabase.from('game_servers').select('*').eq('current_match_id', match.id).single();
        if (!server) continue;

        // Get player count from DatHost API (no UDP - it can hang)
        let playerCount = 0;
        try {
            const res = await fetchWithTimeout(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}`, {
                headers: { 'Authorization': `Basic ${auth}` },
                timeout: 3000
            });
            if (res.ok) playerCount = (await res.json()).players_online || 0;
        } catch (e) {
            console.log(`   ⚠️ API timeout for match ${match.contract_match_id}`);
        }

        console.log(`   📊 Match ${match.contract_match_id}: ${playerCount} player(s) detected`);

        const sendRcon = async (cmd) => {
            try {
                await fetchWithTimeout(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}/console`, {
                    method: 'POST',
                    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ line: cmd })
                });
            } catch (e) { /* ignore */ }
        };

        // AFK Cancel Logic: Only 1 player for 2 minutes = cancel match
        if (playerCount === 1) {
            if (!afkState.has(match.id)) {
                console.log(`   👤 Match ${match.contract_match_id}: 1 player waiting. Starting 2-min AFK timer.`);
                afkState.set(match.id, { start: now });
            } else {
                const elapsed = now - afkState.get(match.id).start;
                if (elapsed >= AFK_TIMEOUT_MS) {
                    console.log(`   ⏰ Match ${match.contract_match_id}: P2 never joined (2 min). Cancelling.`);
                    await sendRcon('say "Opponent did not join in time. Match cancelled."');
                    await sendRcon('kick all');

                    await supabase.from('matches').update({ status: 'CANCELLED', payout_status: 'REFUND_PENDING' }).eq('id', match.id);
                    await supabase.from('game_servers').update({ status: 'FREE', current_match_id: null }).eq('current_match_id', match.id);
                    afkState.delete(match.id);
                }
            }
        } else if (playerCount >= 2) {
            // Both players connected - clear AFK timer
            if (afkState.has(match.id)) {
                console.log(`   👥 Match ${match.contract_match_id}: Both players connected! Native warmup will auto-shorten.`);
                afkState.delete(match.id);
            }
        } else {
            // 0 players - reset state
            afkState.delete(match.id);
        }
    }
}

async function checkTimeouts(supabase, escrow) {
    const now = Date.now();
    const { data: depositing } = await supabase.from('matches').select('*').eq('status', 'DEPOSITING');
    if (depositing) {
        for (const m of depositing) {
            const start = m.deposit_started_at || m.created_at;
            // 15 min timeout for deposits
            if (now - new Date(start).getTime() > 15 * 60 * 1000) {
                if (m.p1_deposited || m.p2_deposited) {
                    const refundAddr = m.p1_deposited ? m.player1_address : m.player2_address;
                    await refundPlayer(supabase, escrow, m, refundAddr);
                } else {
                    await supabase.from('matches').update({ status: 'CANCELLED' }).eq('id', m.id);
                }
            }
        }
    }
}

async function refundPlayer(supabase, escrow, match, playerAddress) {
    try {
        console.log(`   🔒 Refunding match ${match.contract_match_id}...`);
        await supabase.from('matches').update({ status: 'CANCELLED' }).eq('id', match.id);
        const matchIdBytes = numericToBytes32(match.contract_match_id);
        const pot = (await escrow.matches(matchIdBytes))[2];
        if (pot.toString() !== '0') {
            const tx = await escrow.refundMatch(matchIdBytes, playerAddress);
            await tx.wait();
            await supabase.from('matches').update({ payout_status: 'REFUNDED', refund_tx_hash: tx.hash }).eq('id', match.id);
            console.log(`   ✅ Refunded.`);
        } else {
            await supabase.from('matches').update({ payout_status: 'REFUNDED' }).eq('id', match.id);
        }
    } catch (e) {
        console.error(`   Refund error:`, e.message);
        await supabase.from('matches').update({ status: 'CANCELLED', payout_status: 'REFUND_FAILED' }).eq('id', match.id);
    }
}

async function processPayouts(supabase, escrow) {
    const { data: matches } = await supabase.from('matches').select('*').eq('status', 'COMPLETE').eq('payout_status', 'PENDING');
    if (!matches || matches.length === 0) return;

    console.log(`💰 Found ${matches.length} pending payouts.`);
    for (const match of matches) {
        console.log(`   Paying Match ${match.contract_match_id}...`);
        try {
            await supabase.from('matches').update({ payout_status: 'PROCESSING' }).eq('id', match.id);
            const tx = await escrow.distributeWinnings(numericToBytes32(match.contract_match_id), match.winner_address);
            console.log(`   Tx Sent: ${tx.hash}`);
            await tx.wait();
            console.log("   Tx Confirmed!");
            await supabase.from('matches').update({ payout_status: 'PAID' }).eq('id', match.id);
        } catch (e) {
            console.error(`   FAILED payout:`, e.message);
            await supabase.from('matches').update({ payout_status: 'FAILED' }).eq('id', match.id);
        }
    }
}

async function run() {
    if (!PRIVATE_KEY) { console.error("Missing PAYOUT_PRIVATE_KEY"); process.exit(1); }
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);

    console.log(`[${new Date().toISOString()}] Bot cycle starting...`);
    try {
        await verifyDeposits(supabase, provider);
        await assignServers(supabase);
        await checkAutoStart(supabase);
        await checkTimeouts(supabase, escrow);
        await processPayouts(supabase, escrow);
    } catch (e) { console.error("Loop Error:", e); }
}

run();
setInterval(run, 5000);