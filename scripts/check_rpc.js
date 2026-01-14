
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
    console.log("Checking for exec_sql RPC...");
    const { data, error } = await supabase.rpc('exec_sql', { query: 'SELECT 1' });
    if (error) {
        console.error("❌ exec_sql check failed:", error.message);
    } else {
        console.log("✅ exec_sql works! Data:", data);

        // If it works, ADD THE COLUMN
        console.log("Adding updated_at column...");
        const { error: ddlError } = await supabase.rpc('exec_sql', {
            query: 'ALTER TABLE matches ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();'
        });
        if (ddlError) console.error("DDL failed:", ddlError);
        else console.log("✅ Column added successfully!");
    }
}

main();
