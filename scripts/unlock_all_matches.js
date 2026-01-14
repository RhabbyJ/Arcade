
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
    console.log(`Checking for stuck matches...`);

    // Force fix the specific match provided by user
    const { data: stuckMatches, error } = await supabase
        .from('matches')
        .select('*')
        .eq('id', 'dc9f316c-6f58-40c9-a5e0-44ac141aa959');

    if (error) {
        console.error("Error fetching:", error);
        return;
    }

    if (stuckMatches.length === 0) {
        console.log("No stuck matches found.");
        return;
    }

    console.log(`Found ${stuckMatches.length} stuck matches:`);
    stuckMatches.forEach(m => console.log(` - ${m.id} (${m.status}) Lock: ${m.settlement_lock_id}`));

    console.log("\nUnlocking all...");

    for (const m of stuckMatches) {
        const { error: updateError } = await supabase
            .from('matches')
            .update({
                settlement_lock_id: null,
                payout_status: 'PENDING',
                updated_at: new Date().toISOString()
            })
            .eq('id', m.id);

        if (updateError) console.error(`Failed to unlock ${m.id}:`, updateError);
        else console.log(`✅ Unlocked ${m.id}`);
    }
}

main();
