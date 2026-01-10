/**
 * Janitor Cron - Settlement Reconciliation
 * 
 * This script:
 * 1. Finds stuck matches (DATHOST_BOOTING, LIVE that are too old)
 * 2. Polls DatHost for truth
 * 3. Acquires atomic DB lock
 * 4. Reconciles chain state
 * 5. Executes settlement if needed
 * 
 * Run: npx ts-node scripts/payout_cron.ts
 * or build and run with node
 */

import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

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
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || process.env.NEXT_PUBLIC_ESCROW_ADDRESS!;
const PAYOUT_PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY!;
const DATHOST_USER = process.env.DATHOST_USER || process.env.DATHOST_USERNAME!;
const DATHOST_PASS = process.env.DATHOST_PASS || process.env.DATHOST_PASSWORD!;

const ESCROW_ABI = [
    "function distributeWinnings(bytes32 matchId, address winner) external",
    "function refundMatch(bytes32 matchId, address player) external",
    "function getMatch(bytes32 matchId) external view returns (address player1, address player2, uint256 pot, bool isComplete, bool isActive, address winner)"
];

function numericToBytes32(num: string | number): string {
    const hex = BigInt(num).toString(16);
    return '0x' + hex.padStart(64, '0');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PAYOUT_PRIVATE_KEY, provider);
const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);

const FINALIZED = ["PROCESSING", "PAID", "REFUND_PROCESSING", "REFUNDED"];

// --- DatHost API ---

async function getDatHostMatch(dathostMatchId: string): Promise<any> {
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');
    const res = await fetch(`https://dathost.net/api/0.1/cs2-matches/${dathostMatchId}`, {
        headers: { Authorization: `Basic ${auth}` }
    });
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new Error(`DatHost get failed: ${res.status}`);
    return await res.json();
}

// --- Reconciliation ---

async function receiptStatus(txHash: string): Promise<string> {
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

async function reconcileSettlement(match: any): Promise<{ done: boolean; reason: string }> {
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
    } catch (e: any) {
        console.error("Contract check error:", e.message);
    }

    return { done: false, reason: "not_settled" };
}

// --- Settlement ---

async function handlePayout(match: any, winnerTeam: "team1" | "team2") {
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

async function handleRefund(match: any) {
    await supabase.from("matches").update({ settlement_kind: "REFUND" }).eq("id", match.id);
    const matchIdBytes32 = numericToBytes32(match.contract_match_id);

    if (match.player1_address) {
        try {
            const tx1 = await escrow.refundMatch(matchIdBytes32, match.player1_address);
            await supabase.from("matches").update({ refund_tx_hash_1: tx1.hash }).eq("id", match.id);
            console.log(`   📝 Refund P1 TX: ${tx1.hash}`);
            await tx1.wait();
        } catch (e: any) {
            if (!e.message?.includes("Nothing to refund")) throw e;
        }
    }

    if (match.player2_address) {
        try {
            const tx2 = await escrow.refundMatch(matchIdBytes32, match.player2_address);
            await supabase.from("matches").update({ refund_tx_hash_2: tx2.hash }).eq("id", match.id);
            console.log(`   📝 Refund P2 TX: ${tx2.hash}`);
            await tx2.wait();
        } catch (e: any) {
            if (!e.message?.includes("Nothing to refund")) throw e;
        }
    }

    await supabase.from("matches").update({
        status: "CANCELLED",
        payout_status: "REFUNDED",
        settled_at: new Date().toISOString(),
    }).eq("id", match.id);
}

// --- Janitor Logic ---

async function acquireLock(matchId: string): Promise<any | null> {
    const lockId = crypto.randomUUID();
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
    const bootingCutoff = new Date(now - 5 * 60_000).toISOString();
    const liveCutoff = new Date(now - 20 * 60_000).toISOString();

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
        let dh: any;
        try {
            dh = await getDatHostMatch(match.dathost_match_id);
        } catch (e: any) {
            console.log(`   ⚠️ DatHost fetch failed: ${e.message}`);
            await supabase.from("matches").update({
                last_settlement_error: `DatHost fetch: ${e.message}`
            }).eq("id", match.id);
            continue;
        }

        // Decide action
        let target: "PAYOUT" | "REFUND" | null = null;
        let winnerTeam: "team1" | "team2" | null = null;

        if (dh.notFound) {
            console.log(`   ℹ️ Match not found in DatHost -> refund`);
            target = "REFUND";
        } else if (dh.status === "cancelled") {
            console.log(`   ℹ️ Match cancelled in DatHost -> refund`);
            target = "REFUND";
        } else if (dh.status === "ended" && dh.winner) {
            console.log(`   ℹ️ Match ended in DatHost -> payout to ${dh.winner}`);
            target = "PAYOUT";
            winnerTeam = dh.winner;
        } else {
            console.log(`   ℹ️ DatHost status: ${dh.status} - skipping`);
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
                await handlePayout({ ...match, ...locked }, winnerTeam!);
                console.log(`   ✅ PAID`);
            } else {
                await handleRefund({ ...match, ...locked });
                console.log(`   ✅ REFUNDED`);
            }
        } catch (e: any) {
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
    console.log("🤖 Janitor Started (DatHost Match API Architecture)");

    while (true) {
        try {
            await runJanitor();
        } catch (e: any) {
            console.error("Janitor loop error:", e.message);
        }
        await new Promise(r => setTimeout(r, 30_000)); // Run every 30s
    }
}

main();
