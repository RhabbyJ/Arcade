import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { handlePayout, handleRefund, logMatchEvent } from "@/lib/settlement";
import { reconcileSettlement } from "@/lib/settlement_reconciler";

// Payout statuses that are terminal (don't process again)
const FINALIZED = ["PROCESSING", "PAID", "REFUND_PROCESSING", "REFUNDED"];

export async function POST(req: Request) {
    // 1. Verify webhook auth
    const authHeader = req.headers.get("authorization")?.trim();
    if (authHeader !== `Bearer ${process.env.DATHOST_WEBHOOK_SECRET}`) {
        console.error("DatHost webhook: unauthorized");
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let event: any;
    try {
        event = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    console.log(`[DatHost Webhook] Event: ${event.type}, Match: ${event.match_group_id}`);

    const matchId = event.match_group_id;
    if (!matchId) {
        return NextResponse.json({ error: "Missing match_group_id" }, { status: 400 });
    }

    // 2. Log event for audit trail (always, regardless of outcome)
    try {
        await logMatchEvent(matchId, "dathost_webhook", event.type, event, event.id);
    } catch (logErr: any) {
        console.error("Failed to log event:", logErr.message);
        // Continue anyway
    }

    // 3. Non-terminal events: just snapshot
    if (!["match_ended", "match_cancelled"].includes(event.type)) {
        await supabaseAdmin.from("matches").update({
            dathost_status_snapshot: event,
        }).eq("id", matchId);

        return NextResponse.json({ received: true, type: event.type });
    }

    // 4. Terminal events: atomic lock + settlement
    const lockId = crypto.randomUUID();

    const { data: match, error: lockError } = await supabaseAdmin
        .from("matches")
        .update({
            payout_status: "PROCESSING",
            payout_event_id: event.id ?? null,
            settlement_lock_id: lockId,
            dathost_status_snapshot: event,
            settlement_attempts: 1,
            last_settlement_error: null,
        })
        .eq("id", matchId)
        .not("payout_status", "in", `(${FINALIZED.map(s => `"${s}"`).join(",")})`)
        .select()
        .maybeSingle();

    if (lockError) {
        console.error("Lock error:", lockError);
        return NextResponse.json({ received: true, note: "Lock error" });
    }

    if (!match) {
        console.log(`Match ${matchId}: already handled or not found`);
        return NextResponse.json({ received: true, note: "Already handled or mismatch" });
    }

    try {
        // 5. Reconcile chain first (in case already settled)
        const recon = await reconcileSettlement(match);
        if (recon.done) {
            console.log(`Match ${matchId}: Reconciled - ${recon.reason}`);
            return NextResponse.json({ received: true, note: `Reconciled: ${recon.reason}` });
        }

        // 6. Execute settlement
        if (event.type === "match_ended") {
            // DatHost sends winner as "team1" or "team2"
            const winnerTeam = event.winner as "team1" | "team2";
            if (!winnerTeam) {
                throw new Error("match_ended but no winner specified");
            }
            await handlePayout(match, winnerTeam);
            console.log(`Match ${matchId}: PAID`);
        } else {
            // match_cancelled
            await handleRefund(match);
            console.log(`Match ${matchId}: REFUNDED`);
        }
    } catch (e: any) {
        console.error(`Settlement error for ${matchId}:`, e.message);
        await supabaseAdmin.from("matches").update({
            payout_status: event.type === "match_cancelled" ? "REFUND_FAILED" : "FAILED",
            last_settlement_error: e.message ?? String(e),
        }).eq("id", match.id);
    }

    return NextResponse.json({ received: true });
}
