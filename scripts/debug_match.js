
require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

async function main() {
    const matchId = "176b8166-f7ef-476f-8e2f-4aa0f7c04b6a";
    console.log(`Inspecting match: ${matchId}`);

    const { data: match, error } = await supabase
        .from("matches")
        .select("*")
        .eq("id", matchId)
        .single();

    if (error) {
        console.error("Error:", error);
    } else {
        console.log("Match Data:");
        console.log("- Status:", match.status);
        console.log("- Payout Status:", match.payout_status);
        console.log("- Lock ID:", match.settlement_lock_id);
        console.log("- Updated At:", match.updated_at);
        console.log("- Settlement Attempts:", match.settlement_attempts);
        console.log("- Last Error:", match.last_settlement_error);

        // Check Server Status
        const { data: server } = await supabase
            .from("game_servers")
            .select("*")
            .eq("current_match_id", matchId)
            .maybeSingle();

        if (server) {
            console.log("\nServer Status:");
            console.log("- ID:", server.id);
            console.log("- Status:", server.status);
            console.log("- Current Match:", server.current_match_id);
        } else {
            console.log("\nServer released (no server found with this match ID).");
        }
    }
}

main();
