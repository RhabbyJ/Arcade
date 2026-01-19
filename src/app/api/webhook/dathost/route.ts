import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { handlePayout, handleRefund, logMatchEvent } from "@/lib/settlement";
import { reconcileSettlement } from "@/lib/settlement_reconciler";

// Payout statuses that are terminal (don't process again)
const FINALIZED = ["PROCESSING", "PAID", "REFUNDED"];

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
    console.log(`[DatHost Webhook] Raw Payload:`, JSON.stringify(event));

    // Infer event type if missing (Fix for "Event: undefined")
    if (!event.type) {
        if (event.cancel_reason) {
            event.type = "match_cancelled";
            console.log("[Webhook] Inferred type: match_cancelled");
        } else if (event.finished === true) {
            event.type = "match_ended";
            console.log("[Webhook] Inferred type: match_ended");
        }
    }

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
            // "Smart Start": Only go LIVE if we actually have 2 connected players (1v1)
            // This prevents false LIVE on warmup end when opponent is missing (disconnected)
            // Note: DatHost players list includes connected: false for players who joined but left
            const distinctPlayers = new Set(
                (event.players || [])
                    .filter((p: any) => p.connected === true)
                    .map((p: any) => p.steam_id_64)
            ).size;

            if (distinctPlayers >= 2) {
                updates.status = 'LIVE';
                updates.match_started_at = new Date().toISOString();
            } else {
                console.log(`[Webhook] Match started but only ${distinctPlayers} connected players. Ignoring LIVE status.`);
            }
        }

        await supabaseAdmin.from("matches").update(updates).eq("id", matchId);

        return NextResponse.json({ received: true, type: event.type });
    }

    // 5. Terminal events: atomic lock + settlement
    const lockId = crypto.randomUUID();

    const { data: lockedMatch, error: lockError } = await supabaseAdmin
        .from("matches")
        .update({
            status: event.type === "match_ended" ? "COMPLETE" : "CANCELLED", // Instant UI update
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

        // 7. Execute settlement (IF we have the keys, otherwise queue for Janitor)
        if (!process.env.PAYOUT_PRIVATE_KEY) {
            console.log(`Match ${matchId}: No private key (Vercel). Updating status and queuing for Janitor.`);

            if (event.type === "match_ended") {
                await supabaseAdmin.from("matches").update({
                    status: "COMPLETE",
                    payout_status: "PROCESSING", // Janitor will pick this up
                    dathost_status_snapshot: event,
                }).eq("id", lockedMatch.id);
            } else {
                await supabaseAdmin.from("matches").update({
                    status: "CANCELLED",
                    payout_status: "PROCESSING", // Janitor will pick this up
                    dathost_status_snapshot: event,
                }).eq("id", lockedMatch.id);
            }
            return NextResponse.json({ received: true, note: "Queued for Janitor" });
        }

        // We have keys (VPS) -> Execute immediately
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
            // payout_status: event.type === "match_cancelled" ? "REFUND_FAILED" : "FAILED", // REMOVED to avoid enum error
            last_settlement_error: e.message ?? String(e),
            settlement_lock_id: null, // Release lock immediately for Janitor retry
        }).eq("id", lockedMatch.id);
    }

    return NextResponse.json({ received: true });
}
