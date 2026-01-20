
require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

async function main() {
    const matchId = "176b8166-f7ef-476f-8e2f-4aa0f7c04b6a";
    console.log(`Fixing stuck match: ${matchId}`);

    // 1. Release Lock
    const { error: lockError } = await supabase
        .from("matches")
        .update({ settlement_lock_id: null })
        .eq("id", matchId);

    if (lockError) console.error("Lock release error:", lockError);
    else console.log("✅ Lock released.");

    // 2. Release Server
    const { error: serverError } = await supabase
        .from("game_servers")
        .update({ status: "FREE", current_match_id: null })
        .eq("current_match_id", matchId);

    if (serverError) console.error("Server release error:", serverError);
    else console.log("✅ Server released.");
}

main();
