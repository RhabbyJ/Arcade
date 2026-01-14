
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');

// Load env vars
const envPaths = [
    path.resolve(__dirname, '../.env.local'),
    path.resolve('/root/base-bot/.env'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env')
];
for (const p of envPaths) {
    if (fs.existsSync(p)) {
        dotenv.config({ path: p });
        break;
    }
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
    const matchId = "9142a9d2-020e-4ae2-b2b9-3aead784bef9";
    const serverId = 1;
    const dathostId = "test_dh_id";
    // Mock dathost response
    const dh = { id: dathostId, game_server_id: "test_gs_id" };
    const serverConnect = "connect 1.2.3.4:27015";

    console.log(`Attempting to update match ${matchId} with server ${serverId}...`);

    const { data, error } = await supabase.from("matches").update({
        dathost_match_id: dathostId,
        server_id: serverId,
        status: "DATHOST_BOOTING",
        dathost_status_snapshot: dh,
        // server_connect: serverConnect,
    }).eq("id", matchId).select();

    if (error) {
        console.error("❌ Update FAILED code:", error.code);
        console.error("❌ Update FAILED message:", error.message);
        console.error("❌ Update FAILED details:", error.details);
        console.error("❌ Update FAILED hint:", error.hint);
    } else {
        console.log("✅ Update SUCCEEDED:", data);
        // Clean up
        console.log("Reverting changes...");
        await supabase.from("matches").update({
            status: "DEPOSITING",
            dathost_match_id: null,
            server_id: null,
            dathost_status_snapshot: null,
            server_connect: null
        }).eq("id", matchId);
    }
}

main();
