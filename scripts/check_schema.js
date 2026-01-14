
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
    console.log("Checking for 'updated_at' column in 'matches' table...");
    try {
        const { data, error } = await supabase
            .from('matches')
            .select('updated_at')
            .limit(1);

        if (error) {
            console.error("❌ 'updated_at' check FAILED:", error.message);
        } else {
            console.log("✅ 'updated_at' column exists.");
        }
    } catch (e) {
        console.error("Exception:", e);
    }
}

main();
