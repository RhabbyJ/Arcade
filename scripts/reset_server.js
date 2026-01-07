const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

async function resetServers() {
    console.log("Resetting all servers to FREE...");
    const { error } = await supabase
        .from('game_servers')
        .update({ status: 'FREE', current_match_id: null })
        .neq('status', 'FREE');

    if (error) console.error("Error:", error);
    else console.log("✅ Servers reset successfully.");
}

resetServers();
