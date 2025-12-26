const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const path = require('path');
const dotenv = require('dotenv');

// Load .env or .env.local from current dir
// Added { quiet: true } to suppress verbose logs
const envLocalPath = path.resolve(__dirname, '.env.local');
const envPath = path.resolve(__dirname, '.env');
const config = { quiet: true }; // Suppress startup tips
dotenv.config({ path: envLocalPath, ...config });
dotenv.config({ path: envPath, ...config });

// --- CONFIG ---
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_ADDRESS;
const PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY;
const RPC_URL = "https://sepolia.base.org";

// DatHost Config
const DATHOST_USER = process.env.DATHOST_USERNAME;
const DATHOST_PASS = process.env.DATHOST_PASSWORD;

// V2 ABI
const ESCROW_ABI = [
    "function distributeWinnings(bytes32 matchId, address winner) external",
    "function refundMatch(bytes32 matchId, address player) external",
    "function matches(bytes32) view returns (address player1, address player2, uint256 pot, bool isComplete, bool isActive)"
];

// --- HELPERS ---
function numericToBytes32(num) {
    const hex = BigInt(num).toString(16);
    return '0x' + hex.padStart(64, '0');
}

// ---------------------------------------------------------
// 1. FORFEIT MONITOR (Rage Quit Detector)
// ---------------------------------------------------------
async function checkForfeits(supabase) {
    const { data: matches, error } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'LIVE');

    if (error || !matches || matches.length === 0) return;

    // Filter for disconnects (where disconnect_time is NOT null)
    const disconnectMatches = matches.filter(m => m.player1_disconnect_time || m.player2_disconnect_time);

    if (disconnectMatches.length === 0) return;

    const FORFEIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 Minutes
    const now = Date.now();

    for (const match of disconnectMatches) {
        let disconnectedPlayer = null;
        let winnerAddress = null;
        let disconnectTime = 0;

        if (match.player1_disconnect_time) {
            disconnectTime = new Date(match.player1_disconnect_time).getTime();
            if (now - disconnectTime > FORFEIT_TIMEOUT_MS) {
                disconnectedPlayer = 'Player 1';
                winnerAddress = match.player2_address;
            }
        } else if (match.player2_disconnect_time) {
            disconnectTime = new Date(match.player2_disconnect_time).getTime();
            if (now - disconnectTime > FORFEIT_TIMEOUT_MS) {
                disconnectedPlayer = 'Player 2';
                winnerAddress = match.player1_address;
            }
        }

        if (winnerAddress) {
            console.log(`🚨 AUTO-FORFEIT Match ${match.contract_match_id} | Winner: ${winnerAddress}`);

            await supabase
                .from('matches')
                .update({
                    status: 'COMPLETE',
                    winner_address: winnerAddress,
                    payout_status: 'PENDING'
                })
                .eq('id', match.id);

            await resetServer(supabase, match.id);
        }
    }
}

async function resetServer(supabase, matchId) {
    const { data: server } = await supabase
        .from('game_servers')
        .select('*')
        .eq('current_match_id', matchId)
        .single();

    if (!server || !DATHOST_USER || !DATHOST_PASS) return;

    // console.log(`   🧹 Cleaning server ${server.id}...`);
    const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');
    const cmds = ['kickall', 'css_endmatch'];

    for (const cmd of cmds) {
        try {
            await fetch(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}/console`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({ line: cmd }).toString()
            });
        } catch (e) {
            console.error("   RCON Error:", e.message);
        }
    }

    await supabase
        .from('game_servers')
        .update({ status: 'FREE', current_match_id: null })
        .eq('id', server.id);
}

// ---------------------------------------------------------
// 2. PAYOUT PROCESSOR (Winner gets paid)
// ---------------------------------------------------------
async function processPayouts(supabase, escrow) {
    const { data: matches } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'COMPLETE')
        .eq('payout_status', 'PENDING');

    if (!matches || matches.length === 0) return;

    console.log(`💰 Found ${matches.length} pending payouts.`);

    for (const match of matches) {
        const matchIdBytes32 = numericToBytes32(match.contract_match_id);
        const winner = match.winner_address;

        console.log(`   Paying Match ${match.contract_match_id}... -> ${winner}`);

        try {
            await supabase.from('matches').update({ payout_status: 'PROCESSING' }).eq('id', match.id);

            const tx = await escrow.distributeWinnings(matchIdBytes32, winner);
            console.log(`   Tx Sent: ${tx.hash}`);
            await tx.wait();
            console.log("   Tx Confirmed!");

            await supabase.from('matches').update({ payout_status: 'PAID' }).eq('id', match.id);

        } catch (e) {
            console.error(`   FAILED payout ${match.contract_match_id}:`, e.message);
            await supabase.from('matches').update({ payout_status: 'FAILED' }).eq('id', match.id);
        }
    }
}

// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------
async function run() {
    if (!PRIVATE_KEY) {
        console.error("ERROR: PAYOUT_PRIVATE_KEY not found in .env");
        process.exit(1);
    }

    // Simplified Log (User Request)
    console.log(`[${new Date().toISOString()}] Checking for payouts...`);

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);

    try {
        await checkForfeits(supabase);
        await processPayouts(supabase, escrow);
    } catch (e) {
        console.error("Loop Error:", e);
    }
}

// Run (Startup banner removed for cleanliness)
run();
