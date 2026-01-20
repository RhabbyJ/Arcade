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
    p1_deposit_verified?: boolean;
    p2_deposit_verified?: boolean;
    p1_tx_hash?: string;
    p2_tx_hash?: string;
    [key: string]: any;
}

/**
 * Handle payout for a completed match.
 * - Idempotent settlement on EscrowV4
 * - "Best effort" push payment for UX
 */
export async function handlePayout(match: any, winnerAddress: string) {
    if (!winnerAddress) throw new Error("handlePayout: No winner address");

    // 1. Finalize DB state & Release Server
    // We do this first for instant UI response
    const { error: matchError } = await supabaseAdmin.from("matches").update({
        status: "COMPLETE",
        payout_status: "PAID",
        winner_address: winnerAddress,
        settled_at: new Date().toISOString(),
        last_settlement_error: null,
        settlement_kind: "PAYOUT"
    }).eq("id", match.id);

    if (matchError) throw new Error(`Payout DB Match Update Failed: ${matchError.message}`);

    // Release Server
    await supabaseAdmin.from("game_servers")
        .update({ status: "FREE", current_match_id: null })
        .eq("current_match_id", match.id);

    const matchIdBytes32 = numericToBytes32(match.contract_match_id);
    const apiEscrow = getEscrow();

    try {
        // 2. Settle on-chain (Writes claimable balance)
        const tx = await apiEscrow.settleMatch(matchIdBytes32, winnerAddress);
        console.log(`SettleMatch TX: ${tx.hash}`);
        await tx.wait();

        // 3. Push payout (Best Effort push to wallet)
        try {
            const wTx = await apiEscrow.withdrawFor(winnerAddress);
            await wTx.wait();
        } catch (e: any) {
            console.log(`withdrawFor push failed/skipped: ${e.message}`);
        }

        return { txHash: tx.hash };
    } catch (e: any) {
        console.error(`On-chain settlement failed: ${e.message}`);
        throw e;
    }
}

/**
 * Handle refund for a cancelled match.
 * - Idempotent cancel on EscrowV4
 * - Pull-payment model: players can always withdraw manually
 */
export async function handleRefund(match: MatchRecord) {
    // 1. Finalize DB state & Release Server
    const { error: matchError } = await supabaseAdmin.from("matches").update({
        status: "CANCELLED",
        payout_status: "REFUNDED",
        settled_at: new Date().toISOString(),
        last_settlement_error: null,
        settlement_kind: "REFUND",
    }).eq("id", match.id);

    if (matchError) throw new Error(`Refund DB Match Update Failed: ${matchError.message}`);

    // Release Server
    await supabaseAdmin.from("game_servers")
        .update({ status: "FREE", current_match_id: null })
        .eq("current_match_id", match.id);

    const matchIdBytes32 = numericToBytes32(match.contract_match_id);
    const apiEscrow = getEscrow();

    try {
        // 2. Cancel on-chain (Idempotent)
        const tx = await apiEscrow.cancelMatch(matchIdBytes32, "WEBHOOK_CANCEL");
        await tx.wait();

        // 3. Push refunds (Best Effort)
        if (match.player1_address && (match.p1_deposit_verified || match.p1_tx_hash)) {
            try {
                const w1 = await apiEscrow.withdrawFor(match.player1_address);
                await w1.wait();
            } catch (e) { }
        }
        if (match.player2_address && (match.p2_deposit_verified || match.p2_tx_hash)) {
            try {
                const w2 = await apiEscrow.withdrawFor(match.player2_address);
                await w2.wait();
            } catch (e) { }
        }

        return { txHash: tx.hash };
    } catch (e: any) {
        console.error(`On-chain refund failed: ${e.message}`);
        throw e;
    }
}

/**
 * Log match event for audit trail
 */
export async function logMatchEvent(
    match_id: string,
    source: "dathost_webhook" | "janitor_poll" | "manual",
    event_type: string,
    payload: any,
    event_id?: string
) {
    await supabaseAdmin.from("match_events").insert({
        match_id,
        source,
        event_type,
        event_id,
        payload,
    });
}
