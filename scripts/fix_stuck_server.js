
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

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing Supabase credentials");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
    console.log("Resetting stuck server...");

    // Find the stuck server (ID 1)
    const { error } = await supabase
        .from('game_servers')
        .update({
            status: 'FREE',
            current_match_id: null,
            last_heartbeat: new Date().toISOString() // Update heartbeat just in case
        })
        .eq('id', 1); // We know it's ID 1 from the logs/verification

    if (error) {
        console.error("❌ Failed to reset server:", error);
    } else {
        console.log("✅ Server 1 reset to FREE. The bot should now pick it up.");
    }
}

main();
