
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
        console.log(`Loaded env from: ${p}`);
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
    console.log("⚠️  WIPING DATABASE FOR FRESH TEST ⚠️");

    // 1. Reset Servers
    console.log("1. Resetting Game Servers...");
    const { error: sErr } = await supabase
        .from('game_servers')
        .update({ status: 'FREE', current_match_id: null });

    if (sErr) console.error("❌ Error resetting servers:", sErr);
    else console.log("✅ Servers set to FREE");

    // 2. Delete Match Events (Foreign Key usually)
    console.log("2. Deleting Match Events...");
    const { error: eErr } = await supabase
        .from('match_events')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Hack to delete all

    if (eErr) console.log("   (Note: match_events table might be empty or missing, skipping)");
    else console.log("✅ Match Events Deleted");

    // 3. Delete Matches
    console.log("3. Deleting Matches...");
    const { error: mErr } = await supabase
        .from('matches')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Hack to delete all

    if (mErr) console.error("❌ Error deleting matches:", mErr);
    else console.log("✅ Matches Deleted");

    console.log("\n✨ DATABASE CLEAN. READY FOR FRESH TEST. ✨");
}

main();
