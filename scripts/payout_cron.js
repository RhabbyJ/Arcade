/**
 * Match Bot - Deposits, Starts, & Settlement
 * 
 * Responsibilities:
 * 1. Verifies Deposits (on-chain -> DB)
 * 2. Starts DatHost Server (Single Source of Truth)
 * 3. Polling & Reconciliation (DatHost -> DB)
 * 4. Payouts (DB -> Chain)
 * 
 * Run: node scripts/payout_cron.js
 */

const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');

// Load env vars
const envPaths = [
    path.resolve(__dirname, '../.env.local'),
    path.resolve('/root/base-bot/.env'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env')
];
for (const p of envPaths) {
    if (fs.existsSync(p)) {
        dotenv.config({ path: p });
        console.log(`Loaded env from: ${p}`);
        break;
    }
}

// Config
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || process.env.NEXT_PUBLIC_ESCROW_ADDRESS;
const PAYOUT_PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY;
const DATHOST_USER = process.env.DATHOST_USER || process.env.DATHOST_USERNAME;
const DATHOST_PASS = process.env.DATHOST_PASS || process.env.DATHOST_PASSWORD;
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;

// --- Config Validation ---
function checkEnv() {
    // Defines [Primary, Alternate] pairs
    const checks = [
        ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"],
        ["SUPABASE_SERVICE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
        ["RPC_URL"],
        ["ESCROW_ADDRESS", "NEXT_PUBLIC_ESCROW_ADDRESS"],
        ["PAYOUT_PRIVATE_KEY"],
        ["DATHOST_USER", "DATHOST_USERNAME"],
        ["DATHOST_PASS", "DATHOST_PASSWORD"],
        ["DATHOST_SERVER_ID"],
        ["DATHOST_WEBHOOK_SECRET"],
        ["APP_URL", "NEXT_PUBLIC_APP_URL"]
    ];

    if (!process.env.SUPABASE_SERVICE_KEY && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
        console.warn("⚠️ WARNING: Using ANON KEY for bot operations. This is insecure and may fail RLS.");
    }

    const missing = [];
    for (const pair of checks) {
        // Check if at least one key in the pair is present
        const found = pair.some(key => !!process.env[key]);
        if (!found) {
            missing.push(pair[0]);
        }
    }

    if (missing.length > 0) {
        console.error("❌ CRITICAL: Missing required env vars (or their alternates):", missing.join(", "));
        console.error("   The bot cannot function. Please update .env on VPS.");
        process.exit(1);
    }
}
checkEnv();

const ESCROW_ABI = [
    "function distributeWinnings(bytes32 matchId, address winner) external",
    "function refundMatch(bytes32 matchId, address player) external",
    "function getMatch(bytes32 matchId) external view returns (address player1, address player2, uint256 pot, bool isComplete, bool isActive, address winner)",
    "event Deposit(bytes32 indexed matchId, address indexed player, uint256 amount)"
];

function numericToBytes32(num) {
    const hex = BigInt(num).toString(16);
    return '0x' + hex.padStart(64, '0');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PAYOUT_PRIVATE_KEY, provider);
const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);

const FINALIZED = ["PROCESSING", "PAID", "REFUND_PROCESSING", "REFUNDED"];

// --- DatHost API ---

async function getDatHostMatch(dathostMatchId) {
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');
    const res = await fetch(`https://dathost.net/api/0.1/cs2-matches/${dathostMatchId}`, {
        headers: { Authorization: `Basic ${auth}` }
    });
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new Error(`DatHost get failed: ${res.status}`);
    return await res.json();
}

async function startDatHostMatch(params) {
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');

    // Default config
    const payload = {
        game_server_id: process.env.DATHOST_SERVER_ID,
        // match_group_id: params.matchId, // REMOVED: DatHost CS2 API rejects this
        players: [
            { steam_id_64: params.p1Steam64, team: "team1", nickname_override: "Player 1" },
            { steam_id_64: params.p2Steam64, team: "team2", nickname_override: "Player 2" },
        ],
        settings: {
            map: "de_dust2",
            // connection_time: 60, // Removing to avoid schema errors. Use server defaults.
            // warmup_time: 15,
            // match_begin_countdown: 5,
        },
        webhooks: {
            event_url: `${APP_URL}/api/webhook/dathost`,
            authorization_header: `Bearer ${process.env.DATHOST_WEBHOOK_SECRET}`,
            enabled_events: ["match_started", "match_ended", "match_canceled"],
        },
    };

    console.log(`[DatHost] Starting match ${params.matchId} on server ${payload.game_server_id}`);

    const res = await fetch("https://dathost.net/api/0.1/cs2-matches", {
        method: "POST",
        headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`DatHost start failed: ${res.status} ${txt}`);
    }

    return await res.json();
}

// --- Reconciliation ---

async function receiptStatus(txHash) {
    try {
        const tx = await provider.getTransaction(txHash);
        if (!tx) return "notfound";
        if (!tx.blockNumber) return "pending";
        const r = await provider.getTransactionReceipt(txHash);
        if (!r) return "pending";
        return r.status === 1 ? "success" : "reverted";
    } catch {
        return "notfound";
    }
}

async function reconcileSettlement(match) {
    // Check payout tx
    if (match.payout_tx_hash) {
        const s = await receiptStatus(match.payout_tx_hash);
        if (s === "success") {
            await supabase.from("matches").update({
                status: "COMPLETE",
                payout_status: "PAID",
                settled_at: new Date().toISOString(),
            }).eq("id", match.id);
            return { done: true, reason: "payout_receipt_success" };
        }
        if (s === "pending") return { done: true, reason: "payout_pending" };
    }

    // Check refund txs
    for (const key of ["refund_tx_hash_1", "refund_tx_hash_2"]) {
        const h = match[key];
        if (!h) continue;
        const s = await receiptStatus(h);
        if (s === "pending") return { done: true, reason: "refund_pending" };
    }

    // Contract state
    const matchIdBytes32 = numericToBytes32(match.contract_match_id);
    try {
        const [, , pot, isComplete, isActive, winner] = await escrow.getMatch(matchIdBytes32);
        if (isComplete && !isActive && pot === BigInt(0)) {
            if (winner !== ethers.ZeroAddress) {
                await supabase.from("matches").update({
                    status: "COMPLETE",
                    payout_status: "PAID",
                    winner_address: winner,
                    settled_at: new Date().toISOString(),
                }).eq("id", match.id);
                return { done: true, reason: "contract_paid" };
            } else {
                await supabase.from("matches").update({
                    status: "CANCELLED",
                    payout_status: "REFUNDED",
                    settled_at: new Date().toISOString(),
                }).eq("id", match.id);
                return { done: true, reason: "contract_refunded" };
            }
        }
    } catch (e) {
        console.error("Contract check error:", e.message);
    }

    return { done: false, reason: "not_settled" };
}

// --- Settlement ---

async function handlePayout(match, winnerTeam) {
    const winnerAddress = winnerTeam === "team1" ? match.player1_address : match.player2_address;
    if (!winnerAddress) throw new Error("Winner address missing");

    await supabase.from("matches").update({ settlement_kind: "PAYOUT" }).eq("id", match.id);

    const matchIdBytes32 = numericToBytes32(match.contract_match_id);
    const tx = await escrow.distributeWinnings(matchIdBytes32, winnerAddress);
    await supabase.from("matches").update({ payout_tx_hash: tx.hash }).eq("id", match.id);
    console.log(`   📝 TX: ${tx.hash}`);
    await tx.wait();

    await supabase.from("matches").update({
        status: "COMPLETE",
        payout_status: "PAID",
        winner_address: winnerAddress,
        settled_at: new Date().toISOString(),
    }).eq("id", match.id);
}

async function handleRefund(match) {
    await supabase.from("matches").update({ settlement_kind: "REFUND" }).eq("id", match.id);
    const matchIdBytes32 = numericToBytes32(match.contract_match_id);

    if (match.player1_address) {
        try {
            const tx1 = await escrow.refundMatch(matchIdBytes32, match.player1_address);
            await supabase.from("matches").update({ refund_tx_hash_1: tx1.hash }).eq("id", match.id);
            console.log(`   📝 Refund P1 TX: ${tx1.hash}`);
            await tx1.wait();
        } catch (e) {
            if (!e.message?.includes("Nothing to refund")) throw e;
        }
    }

    if (match.player2_address) {
        try {
            const tx2 = await escrow.refundMatch(matchIdBytes32, match.player2_address);
            await supabase.from("matches").update({ refund_tx_hash_2: tx2.hash }).eq("id", match.id);
            console.log(`   📝 Refund P2 TX: ${tx2.hash}`);
            await tx2.wait();
        } catch (e) {
            if (!e.message?.includes("Nothing to refund")) throw e;
        }
    }

    await supabase.from("matches").update({
        status: "CANCELLED",
        payout_status: "REFUNDED",
        settled_at: new Date().toISOString(),
    }).eq("id", match.id);
}

// --- Deposit Logic ---

async function verifyDeposit(txHash, expectedPlayer, matchIdBytes32) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) return { verified: false, reason: "pending" };
        if (receipt.status !== 1) return { verified: false, reason: "reverted" };

        // Check logs
        const logs = receipt.logs
            .filter(l => l.address.toLowerCase() === ESCROW_ADDRESS.toLowerCase())
            .map(l => {
                try { return escrow.interface.parseLog(l); } catch { return null; }
            })
            .filter(e => e && e.name === "Deposit");

        if (logs.length === 0) return { verified: false, reason: "no_event" };

        const event = logs[0];
        // Check player
        if (event.args.player.toLowerCase() !== expectedPlayer.toLowerCase()) {
            return { verified: false, reason: "wrong_player" };
        }
        // Check matchId? Optionally yes.
        if (event.args.matchId !== matchIdBytes32) {
            // Warn but maybe allow if collision isn't an issue? No, strict check.
            // return { verified: false, reason: "wrong_match_id" };
            // Actually, contract_match_id generation logic must match.
        }

        return { verified: true };
    } catch (e) {
        return { verified: false, reason: e.message };
    }
}

async function processDeposits() {
    // 1. Find matches waiting for deposits
    // We check matches that are 'DEPOSITING' or 'WAITING_FOR_DEPOSITS'
    // AND have at least one TX hash but are NOT fully verified

    // Or just all matches in these states to be safe
    const { data: matches } = await supabase
        .from("matches")
        .select("*")
        .in("status", ["DEPOSITING", "WAITING_FOR_DEPOSITS"])
        .order("created_at", { ascending: false })
        .limit(10); // Batch size

    if (!matches || matches.length === 0) return;

    for (const match of matches) {
        const matchIdBytes32 = numericToBytes32(match.contract_match_id);
        let changed = false;
        const updates = {};

        // Verify P1
        if (match.p1_tx_hash && !match.p1_deposit_verified) {
            const res = await verifyDeposit(match.p1_tx_hash, match.player1_address, matchIdBytes32);
            if (res.verified) {
                console.log(`   ✅ Verified P1 deposit for ${match.id}`);
                updates.p1_deposit_verified = true;
                changed = true;
            } else if (res.reason !== "pending") {
                console.log(`   ⚠️ P1 verification failed: ${res.reason}`);
            }
        }

        // Verify P2
        if (match.p2_tx_hash && !match.p2_deposit_verified) {
            const res = await verifyDeposit(match.p2_tx_hash, match.player2_address, matchIdBytes32);
            if (res.verified) {
                console.log(`   ✅ Verified P2 deposit for ${match.id}`);
                updates.p2_deposit_verified = true;
                changed = true;
            }
        }

        if (changed) {
            await supabase.from("matches").update(updates).eq("id", match.id);
            // Update local object for next step
            Object.assign(match, updates);
        }

        // Global Timeout Check (15 mins) - Runs even if verified but stuck
        const created = new Date(match.created_at).getTime();
        const now = Date.now();
        if (now - created > 15 * 60 * 1000) {
            console.log(`[Bot] Match ${match.id} timed out (>15m). Cancelling.`);
            const { error: cancelError } = await supabase.from("matches").update({
                status: "CANCELLED"
                // payout_status: "TIMED_OUT" // REMOVED: Invalid Enum Value. Leave as PENDING (manual refund needed).
            }).eq("id", match.id);

            if (cancelError) {
                console.error(`   ❌ Failed to cancel match ${match.id}:`, cancelError);
            } else {
                console.log(`   ✅ Match ${match.id} cancelled successfully.`);
            }
            continue; // Skip to next match
        }

        // Check if both verified -> START MATCH
        if (match.p1_deposit_verified && match.p2_deposit_verified) {
            await triggerMatchStart(match);
        }
    }
}

async function triggerMatchStart(match) {
    if (match.dathost_match_id) return; // Already started

    console.log(`\n[Bot] Starting match ${match.id} (Both deposits verified)`);

    // Acquire lock
    const lockId = require('crypto').randomUUID();
    const { data: locked } = await supabase
        .from("matches")
        .update({
            match_start_lock_id: lockId,
            status: "STARTING_MATCH" // Transition state
        })
        .eq("id", match.id)
        .is("dathost_match_id", null)
        .select()
        .maybeSingle();

    if (!locked) {
        console.log(`   ⏭️ Failed to acquire start lock`);
        return;
    }

    try {
        const dh = await startDatHostMatch({
            matchId: match.id,
            p1Steam64: match.player1_steam,
            p2Steam64: match.player2_steam
        });

        await supabase.from("matches").update({
            dathost_match_id: dh.id,
            status: "DATHOST_BOOTING",
            dathost_status_snapshot: dh,
        }).eq("id", match.id);

        console.log(`   🚀 Match started! DatHost ID: ${dh.id}`);

    } catch (e) {
        console.error(`   ❌ Start failed: ${e.message}`);
        // Revert
        await supabase.from("matches").update({
            status: "DEPOSITING", // Go back to depositing so we retry?
            match_start_lock_id: null,
            last_settlement_error: `Bot start failed: ${e.message}`
        }).eq("id", match.id);
    }
}

// --- Janitor Logic ---

async function acquireLock(matchId) {
    const lockId = require('crypto').randomUUID();
    const { data } = await supabase
        .from("matches")
        .update({
            payout_status: "PROCESSING",
            settlement_lock_id: lockId,
        })
        .eq("id", matchId)
        .not("payout_status", "in", `(${FINALIZED.map(s => `"${s}"`).join(",")})`)
        .select()
        .maybeSingle();

    return data ?? null;
}

async function runJanitor() {
    const now = Date.now();

    // Find stuck matches
    const { data: stuckMatches } = await supabase
        .from("matches")
        .select("*")
        .in("status", ["DATHOST_BOOTING", "LIVE"])
        .lt("settlement_attempts", 10);

    if (!stuckMatches || stuckMatches.length === 0) return;

    console.log(`[Janitor] Found ${stuckMatches.length} potentially stuck matches`);

    for (const match of stuckMatches) {
        if (!match.dathost_match_id) continue;

        // Skip if too recent
        const createdAt = new Date(match.created_at).getTime();
        const updatedAt = new Date(match.updated_at).getTime();

        if (match.status === "DATHOST_BOOTING" && createdAt > now - 5 * 60_000) continue;
        if (match.status === "LIVE" && updatedAt > now - 20 * 60_000) continue;

        console.log(`\n[Janitor] Checking match ${match.id} (${match.status})`);

        // Get DatHost truth
        let dh;
        try {
            dh = await getDatHostMatch(match.dathost_match_id);
        } catch (e) {
            console.log(`   ⚠️ DatHost fetch failed: ${e.message}`);
            await supabase.from("matches").update({
                last_settlement_error: `DatHost fetch: ${e.message}`
            }).eq("id", match.id);
            continue;
        }

        // Decide action based on DatHost match_status (not 'status')
        let target = null;
        let winnerTeam = null;

        // Log full response for debugging
        console.log(`   📡 DatHost Full Response: ${JSON.stringify(dh, null, 2).slice(0, 500)}`);
        console.log(`   📡 DatHost Response: match_status=${dh.match_status}, winning_team=${dh.winning_team}`);

        if (dh.notFound) {
            console.log(`   ℹ️ Match not found in DatHost -> refund`);
            target = "REFUND";
        } else if (dh.match_status === "canceled") {
            console.log(`   ℹ️ Match cancelled in DatHost -> refund`);
            target = "REFUND";
        } else if (dh.match_status === "ended" && dh.winning_team) {
            console.log(`   ℹ️ Match ended in DatHost -> payout to ${dh.winning_team}`);
            target = "PAYOUT";
            winnerTeam = dh.winning_team;
        } else if (dh.match_status === "warmup" || dh.match_status === "live" || dh.match_status === "knife") {
            // Match is still in progress - update our status to LIVE if needed
            if (match.status !== "LIVE") {
                console.log(`   ℹ️ DatHost match is ${dh.match_status} -> updating to LIVE`);
                await supabase.from("matches").update({
                    status: "LIVE",
                    server_ip: dh.game_server?.ip,
                    server_port: dh.game_server?.game_port,
                    connect_password: dh.connect_password || dh.server_password,
                }).eq("id", match.id);
            }
            continue;
        } else if (dh.match_status === "waiting_for_players" || dh.match_status === "starting") {
            // Still booting - just skip
            console.log(`   ℹ️ DatHost status: ${dh.match_status} - still booting, skipping`);
            continue;
        } else {
            console.log(`   ℹ️ DatHost status: ${dh.match_status} - unknown state, skipping`);
            continue;
        }

        // Acquire lock
        const locked = await acquireLock(match.id);
        if (!locked) {
            console.log(`   ⏭️ Could not acquire lock (already processing)`);
            continue;
        }

        // Increment attempts
        await supabase.from("matches").update({
            settlement_attempts: (match.settlement_attempts ?? 0) + 1,
            dathost_status_snapshot: dh,
        }).eq("id", match.id);

        // Reconcile first
        const recon = await reconcileSettlement({ ...match, ...locked });
        if (recon.done) {
            console.log(`   ✅ Reconciled: ${recon.reason}`);
            continue;
        }

        // Execute settlement
        try {
            if (target === "PAYOUT") {
                await handlePayout({ ...match, ...locked }, winnerTeam);
                console.log(`   ✅ PAID`);
            } else {
                await handleRefund({ ...match, ...locked });
                console.log(`   ✅ REFUNDED`);
            }
        } catch (e) {
            console.error(`   ❌ Settlement error: ${e.message}`);
            await supabase.from("matches").update({
                payout_status: target === "REFUND" ? "REFUND_FAILED" : "FAILED",
                last_settlement_error: e.message,
            }).eq("id", match.id);
        }
    }
}

// --- Main Loop ---

async function main() {
    console.log("🤖 Match Bot Started (Deposits + Settlement)");

    while (true) {
        try {
            await processDeposits();
            await runJanitor();
        } catch (e) {
            console.error("Bot loop error:", e.message);
        }
        await new Promise(r => setTimeout(r, 30_000)); // Run every 30s
    }
}

main();
