import { ethers } from "ethers";
import { supabaseAdmin } from "./supabaseAdmin";
import { ESCROW_ABI, numericToBytes32 } from "./abi";

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

// Lazy-load to prevent crashes on Vercel where keys might be missing
function getEscrow() {
    if (!process.env.PAYOUT_PRIVATE_KEY) {
        throw new Error("Missing PAYOUT_PRIVATE_KEY");
    }
    const wallet = new ethers.Wallet(process.env.PAYOUT_PRIVATE_KEY, provider);
    return new ethers.Contract(process.env.ESCROW_ADDRESS!, ESCROW_ABI, wallet);
}

export interface MatchRecord {
    id: string;
    contract_match_id: string | number;
    player1_address: string;
    player2_address: string;
    [key: string]: any;
}

/**
 * Handle payout for a completed match.
 * - Stores settlement_kind before sending tx
 * - Stores tx hash immediately after broadcast (crash-safe)
 * - Waits for receipt before finalizing DB
 */
export async function handlePayout(match: MatchRecord, winnerTeam: "team1" | "team2"): Promise<string> {
    const winnerAddress = winnerTeam === "team1" ? match.player1_address : match.player2_address;
    if (!winnerAddress) throw new Error("Winner address missing");

    // Mark intent (helps reconciler)
    await supabaseAdmin.from("matches").update({
        settlement_kind: "PAYOUT",
        last_settlement_error: null,
    }).eq("id", match.id);

    const matchIdBytes32 = numericToBytes32(match.contract_match_id);

    // Send transaction
    const tx = await getEscrow().distributeWinnings(matchIdBytes32, winnerAddress);

    // Crash-safe: store tx hash immediately
    await supabaseAdmin.from("matches").update({
        payout_tx_hash: tx.hash,
    }).eq("id", match.id);

    // Wait for confirmation
    const receipt = await tx.wait();

    // Finalize DB state
    await supabaseAdmin.from("matches").update({
        status: "COMPLETE",
        payout_status: "PAID",
        winner_address: winnerAddress,
        settled_at: new Date().toISOString(),
        last_settlement_error: null,
    }).eq("id", match.id);

    return receipt.hash as string;
}

/**
 * Handle refund for a cancelled match.
 * - Refunds BOTH players (per-player deposits in updated contract)
 * - Stores tx hashes for each refund
 */
export async function handleRefund(match: MatchRecord): Promise<{ txHash1: string | null; txHash2: string | null }> {
    // Mark intent
    await supabaseAdmin.from("matches").update({
        settlement_kind: "REFUND",
        last_settlement_error: null,
    }).eq("id", match.id);

    const matchIdBytes32 = numericToBytes32(match.contract_match_id);

    let txHash1: string | null = null;
    let txHash2: string | null = null;

    // Refund Player 1
    if (match.player1_address) {
        try {
            const tx1 = await getEscrow().refundMatch(matchIdBytes32, match.player1_address);
            txHash1 = tx1.hash;
            await supabaseAdmin.from("matches").update({ refund_tx_hash_1: txHash1 }).eq("id", match.id);
            await tx1.wait();
        } catch (e: any) {
            // If "Nothing to refund", that's okay (player didn't deposit)
            if (!e.message?.includes("Nothing to refund")) {
                throw e;
            }
        }
    }

    // Refund Player 2
    if (match.player2_address) {
        try {
            const tx2 = await getEscrow().refundMatch(matchIdBytes32, match.player2_address);
            txHash2 = tx2.hash;
            await supabaseAdmin.from("matches").update({ refund_tx_hash_2: txHash2 }).eq("id", match.id);
            await tx2.wait();
        } catch (e: any) {
            if (!e.message?.includes("Nothing to refund")) {
                throw e;
            }
        }
    }

    // Finalize DB state
    await supabaseAdmin.from("matches").update({
        status: "CANCELLED",
        payout_status: "REFUNDED",
        settled_at: new Date().toISOString(),
        last_settlement_error: null,
    }).eq("id", match.id);

    return { txHash1, txHash2 };
}

/**
 * Log match event for audit trail
 */
export async function logMatchEvent(
    matchId: string,
    source: "dathost_webhook" | "janitor_poll" | "manual",
    eventType: string,
    payload: any,
    eventId?: string
) {
    await supabaseAdmin.from("match_events").insert({
        match_id: matchId,
        source,
        event_type: eventType,
        event_id: eventId,
        payload,
    });
}
