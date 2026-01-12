import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { startDatHostMatch } from "@/lib/dathost";

const STARTED_STATUSES = ["DATHOST_BOOTING", "LIVE", "COMPLETE", "CANCELLED", "PROCESSING"];

/**
 * Attempts to start a DatHost match after both deposits are verified.
 * Uses atomic locking to prevent race conditions.
 */
export async function maybeStartDatHostMatch(matchId: string) {
    // 1) Read current match state
    const { data: match, error } = await supabaseAdmin
        .from("matches")
        .select("*")
        .eq("id", matchId)
        .single();

    if (error || !match) {
        console.error("[maybeStartDatHost] Match not found:", matchId);
        return { started: false, reason: "match_not_found" };
    }

    // Already started or finished
    if (match.dathost_match_id) {
        return { started: false, reason: "already_has_dathost_match_id" };
    }
    if (STARTED_STATUSES.includes(match.status)) {
        return { started: false, reason: "already_started_or_done" };
    }

    // Require verified deposits
    if (!match.p1_deposit_verified || !match.p2_deposit_verified) {
        return { started: false, reason: "deposits_not_verified" };
    }

    // Require steam ids
    if (!match.player1_steam || !match.player2_steam) {
        return { started: false, reason: "missing_steam_ids" };
    }

    // 2) Acquire start lock atomically
    const lockId = crypto.randomUUID();
    const { data: locked, error: errorLocked } = await supabaseAdmin
        .from("matches")
        .update({
            match_start_lock_id: lockId,
            status: "STARTING_MATCH",
        })
        .eq("id", matchId)
        .is("dathost_match_id", null)
        .in("status", ["DEPOSITING", "WAITING_FOR_DEPOSITS", "READY_TO_START"])
        .select()
        .select()
        .maybeSingle();

    if (errorLocked) {
        console.error("[maybeStartDatHost] Lock update error:", errorLocked);
        return { started: false, reason: "lock_db_error", error: errorLocked.message };
    }

    if (!locked) {
        return { started: false, reason: "lock_failed_or_race" };
    }

    // 3) Call DatHost API
    try {
        console.log(`[maybeStartDatHost] Calling DatHost API for match ${matchId}`);

        const dh = await startDatHostMatch({
            matchId,
            serverId: process.env.DATHOST_SERVER_ID!,
            map: "de_dust2", // Default map, can be configured
            p1Steam64: match.player1_steam,
            p2Steam64: match.player2_steam,
            connectTimeSec: 60,
            warmupTimeSec: 15,
            beginCountdownSec: 5,
        });

        // 4) Persist match id + booting status
        await supabaseAdmin.from("matches").update({
            dathost_match_id: dh.id,
            status: "DATHOST_BOOTING",
            dathost_status_snapshot: dh,
        }).eq("id", matchId);

        console.log(`[maybeStartDatHost] ✅ Match ${matchId} started with DatHost ID: ${dh.id}`);
        return { started: true, dathost_match_id: dh.id };

    } catch (err: any) {
        console.error(`[maybeStartDatHost] ❌ DatHost API failed:`, err.message);

        // Revert status on failure
        await supabaseAdmin.from("matches").update({
            status: "DEPOSITING",
            match_start_lock_id: null,
            last_settlement_error: `DatHost start failed: ${err.message}`,
        }).eq("id", matchId);

        return { started: false, reason: "dathost_api_failed", error: err.message };
    }
}
