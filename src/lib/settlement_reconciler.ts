import { ethers } from "ethers";
import { supabaseAdmin } from "./supabaseAdmin";
import { ESCROW_ABI, numericToBytes32 } from "./abi";

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const escrow = new ethers.Contract(process.env.ESCROW_ADDRESS!, ESCROW_ABI, provider);

export interface ReconcileResult {
    done: boolean;
    reason: string;
}

/**
 * Check tx receipt status
 */
async function receiptStatus(txHash: string): Promise<"success" | "pending" | "reverted" | "notfound"> {
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

/**
 * Reconcile settlement status from chain.
 * Uses:
 * 1. TX receipt status (if tx hash exists)
 * 2. Contract state via getMatch() (if no tx or tx failed)
 * 
 * Returns { done: true } if already settled (don't resend tx).
 * Returns { done: false } if needs settlement.
 */
export async function reconcileSettlement(match: any): Promise<ReconcileResult> {
    // 1) If payout tx exists, reconcile by receipt
    if (match.payout_tx_hash) {
        const s = await receiptStatus(match.payout_tx_hash);
        if (s === "success") {
            await supabaseAdmin.from("matches").update({
                status: "COMPLETE",
                payout_status: "PAID",
                settled_at: new Date().toISOString(),
                last_settlement_error: null,
            }).eq("id", match.id);
            return { done: true, reason: "payout_receipt_success" };
        }
        if (s === "pending") return { done: true, reason: "payout_pending_no_retry" };
        // If reverted or notfound, fall through to contract check
    }

    // 2) Check refund receipts
    for (const key of ["refund_tx_hash_1", "refund_tx_hash_2"] as const) {
        const h = match[key];
        if (!h) continue;
        const s = await receiptStatus(h);
        if (s === "pending") return { done: true, reason: "refund_pending_no_retry" };
    }

    // 3) Contract state via getMatch()
    const matchIdBytes32 = numericToBytes32(match.contract_match_id);

    try {
        const [p1, p2, pot, isComplete, isActive, winner] = await escrow.getMatch(matchIdBytes32);

        // With updated contract:
        // - payout: isComplete=true, isActive=false, pot=0, winner!=0
        // - refund complete: isComplete=true, isActive=false, pot=0, winner==0
        if (isComplete && !isActive && pot === 0n) {
            if (winner !== ethers.ZeroAddress) {
                await supabaseAdmin.from("matches").update({
                    status: "COMPLETE",
                    payout_status: "PAID",
                    winner_address: winner,
                    settled_at: new Date().toISOString(),
                    last_settlement_error: null,
                }).eq("id", match.id);
                return { done: true, reason: "contract_paid" };
            } else {
                await supabaseAdmin.from("matches").update({
                    status: "CANCELLED",
                    payout_status: "REFUNDED",
                    settled_at: new Date().toISOString(),
                    last_settlement_error: null,
                }).eq("id", match.id);
                return { done: true, reason: "contract_refunded" };
            }
        }
    } catch (e: any) {
        // Contract call failed - may be match not created yet
        console.error("Contract reconcile error:", e.message);
    }

    return { done: false, reason: "not_settled" };
}

/**
 * Check if a match is already settled on-chain (quick check for webhook)
 */
export async function isAlreadySettled(contractMatchId: string | number): Promise<boolean> {
    try {
        const matchIdBytes32 = numericToBytes32(contractMatchId);
        const [, , pot, isComplete, isActive] = await escrow.getMatch(matchIdBytes32);
        return isComplete && !isActive && pot === 0n;
    } catch {
        return false;
    }
}
