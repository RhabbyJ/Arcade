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

    const dathostMatchId = event.id;
    console.log(`[DatHost Webhook] Event: ${event.type}, DatHost ID: ${dathostMatchId}`);

    if (!dathostMatchId) {
        return NextResponse.json({ error: "Missing event.id" }, { status: 400 });
    }

    // 2. Find the match in OUR database using the DatHost ID
    const { data: match, error: findError } = await supabaseAdmin
        .from("matches")
        .select("*")
        .eq("dathost_match_id", dathostMatchId)
        .maybeSingle();

    if (!match) {
        console.warn(`[Webhook] No match found for DatHost ID: ${dathostMatchId}`);
        // Return 200 to stop DatHost from retrying forever on a match we don't know about
        return NextResponse.json({ received: true, note: "Match not found in DB" });
    }

    const matchId = match.id;

    // 3. Log event for audit trail
    try {
        await logMatchEvent(matchId, "dathost_webhook", event.type, event, event.id);
    } catch (logErr: any) {
        console.error("Failed to log event:", logErr.message);
    }

    // 4. Non-terminal events: just snapshot
    // Handle both spellings: DatHost uses "match_canceled" (US) but docs may say "match_cancelled" (UK)
    if (!["match_ended", "match_cancelled", "match_canceled"].includes(event.type)) {

        const updates: any = {
            dathost_status_snapshot: event,
        };

        if (event.type === 'match_started') {
            updates.status = 'LIVE';
            updates.match_started_at = new Date().toISOString();
        }

        await supabaseAdmin.from("matches").update(updates).eq("id", matchId);

        return NextResponse.json({ received: true, type: event.type });
    }

    // 5. Terminal events: atomic lock + settlement
    const lockId = crypto.randomUUID();

    const { data: lockedMatch, error: lockError } = await supabaseAdmin
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

    if (!lockedMatch) {
        console.log(`Match ${matchId}: already handled or not found`);
        return NextResponse.json({ received: true, note: "Already handled or mismatch" });
    }

    try {
        // 6. Reconcile chain first
        const recon = await reconcileSettlement(lockedMatch);
        if (recon.done) {
            console.log(`Match ${matchId}: Reconciled - ${recon.reason}`);
            return NextResponse.json({ received: true, note: `Reconciled: ${recon.reason}` });
        }

        // 7. Execute settlement
        if (event.type === "match_ended") {
            const winnerTeam = event.winner as "team1" | "team2";
            if (!winnerTeam) {
                throw new Error("match_ended but no winner specified");
            }
            await handlePayout(lockedMatch, winnerTeam);
            console.log(`Match ${matchId}: PAID`);
        } else {
            // match_cancelled
            await handleRefund(lockedMatch);
            console.log(`Match ${matchId}: REFUNDED`);
        }
    } catch (e: any) {
        console.error(`Settlement error for ${matchId}:`, e.message);
        await supabaseAdmin.from("matches").update({
            payout_status: event.type === "match_cancelled" ? "REFUND_FAILED" : "FAILED",
            last_settlement_error: e.message ?? String(e),
        }).eq("id", lockedMatch.id);
    }

    return NextResponse.json({ received: true });
}
