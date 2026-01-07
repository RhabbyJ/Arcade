const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

async function fixMatch() {
    const matchId = 'c812102f-adc4-4603-b236-cac98e3a55a7';
    console.log(`Fixing match ${matchId}...`);

    const { error } = await supabase
        .from('matches')
        .update({ status: 'LIVE' })
        .eq('id', matchId);

    if (error) console.error("Error:", error);
    else console.log("✅ Match force-set to LIVE.");
}

fixMatch();
