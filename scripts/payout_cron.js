const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const path = require('path');
const dotenv = require('dotenv');

// Load .env or .env.local from current dir
const envLocalPath = path.resolve(__dirname, '.env.local');
const envPath = path.resolve(__dirname, '.env');
const config = { quiet: true };
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

// USDC Address (for tx verification)
const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS;

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
// 1. VERIFY DEPOSITS (NEW - Bot as Oracle)
// ---------------------------------------------------------
async function verifyDeposits(supabase, provider) {
    // Find matches in DEPOSITING with unverified tx_hashes
    const { data: matches, error } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'DEPOSITING')
        .or('p1_tx_hash.not.is.null,p2_tx_hash.not.is.null');

    if (error || !matches || matches.length === 0) return;

    for (const match of matches) {
        // Verify P1 deposit
        if (match.p1_tx_hash && !match.p1_deposited) {
            const verified = await verifyTransaction(provider, match.p1_tx_hash);
            if (verified) {
                console.log(`✅ P1 Deposit VERIFIED for match ${match.contract_match_id}`);
                await supabase.from('matches').update({ p1_deposited: true }).eq('id', match.id);
            }
        }

        // Verify P2 deposit
        if (match.p2_tx_hash && !match.p2_deposited) {
            const verified = await verifyTransaction(provider, match.p2_tx_hash);
            if (verified) {
                console.log(`✅ P2 Deposit VERIFIED for match ${match.contract_match_id}`);
                await supabase.from('matches').update({ p2_deposited: true }).eq('id', match.id);
            }
        }
    }
}

async function verifyTransaction(provider, txHash) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt && receipt.status === 1) {
            // Transaction was successful
            return true;
        }
        return false;
    } catch (e) {
        console.error(`Error verifying tx ${txHash}:`, e.message);
        return false;
    }
}

// ---------------------------------------------------------
// 2. ASSIGN SERVERS (NEW - After Both Deposits)
// ---------------------------------------------------------
async function assignServers(supabase) {
    // Find matches where both deposited but no server assigned
    const { data: matches, error } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'DEPOSITING')
        .eq('p1_deposited', true)
        .eq('p2_deposited', true)
        .is('server_id', null);

    if (error || !matches || matches.length === 0) return;

    for (const match of matches) {
        // RACE CONDITION GUARD: Re-fetch to ensure match wasn't already processed
        const { data: freshMatch } = await supabase
            .from('matches')
            .select('status, server_id')
            .eq('id', match.id)
            .single();

        if (!freshMatch || freshMatch.status !== 'DEPOSITING' || freshMatch.server_id) {
            // Already processed by another cycle, skip
            continue;
        }

        console.log(`🎮 Both players deposited for match ${match.contract_match_id}. Assigning server...`);

        // Find a FREE server
        const { data: server, error: findError } = await supabase
            .from('game_servers')
            .select('*')
            .eq('status', 'FREE')
            .limit(1)
            .single();

        if (findError || !server) {
            console.log(`   ⚠️ No free servers available. Will retry next cycle.`);
            continue;
        }

        // Mark server as BUSY
        await supabase
            .from('game_servers')
            .update({
                status: 'BUSY',
                current_match_id: match.id,
                last_heartbeat: new Date().toISOString()
            })
            .eq('id', server.id);

        // Reset server via RCON
        if (DATHOST_USER && DATHOST_PASS) {
            const auth = Buffer.from(`${DATHOST_USER}:${DATHOST_PASS}`).toString('base64');
            try {
                await fetch(`https://dathost.net/api/0.1/game-servers/${server.dathost_id}/console`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: new URLSearchParams({ line: 'css_endmatch; mp_restartgame 1' })
                });
            } catch (e) {
                console.error("RCON reset error:", e.message);
            }
        }

        // Update match to LIVE
        const { error: liveError } = await supabase
            .from('matches')
            .update({
                status: 'LIVE',
                server_id: server.id,
                server_assigned_at: new Date().toISOString()
            })
            .eq('id', match.id);

        if (liveError) {
            console.error(`   ❌ Failed to set LIVE status:`, liveError);
        } else {
            console.log(`   🚀 Match ${match.contract_match_id} is now LIVE on ${server.name}`);
        }
    }
}

// ---------------------------------------------------------
// 3. CHECK TIMEOUTS (NEW - Auto-cancel stale matches)
// ---------------------------------------------------------
async function checkTimeouts(supabase, escrow) {
    const now = Date.now();
    const LOBBY_TIMEOUT_MS = 15 * 60 * 1000;    // 15 minutes
    const DEPOSIT_TIMEOUT_MS = 10 * 60 * 1000;  // 10 minutes

    // A. Check stale WAITING/LOBBY matches
    const { data: waitingMatches } = await supabase
        .from('matches')
        .select('*')
        .in('status', ['WAITING', 'LOBBY']);

    if (waitingMatches) {
        for (const match of waitingMatches) {
            const createdAt = new Date(match.created_at).getTime();
            if (now - createdAt > LOBBY_TIMEOUT_MS) {
                console.log(`⏰ TIMEOUT: Match ${match.contract_match_id} in LOBBY for >15min. Cancelling.`);
                await supabase.from('matches').update({ status: 'CANCELLED' }).eq('id', match.id);
            }
        }
    }

    // B. Check stale DEPOSITING matches (only one player paid)
    const { data: depositingMatches } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'DEPOSITING');

    if (depositingMatches) {
        for (const match of depositingMatches) {
            const createdAt = new Date(match.created_at).getTime();
            const isStale = now - createdAt > DEPOSIT_TIMEOUT_MS;

            if (!isStale) continue;

            // Check if only one player deposited
            const onlyP1Paid = match.p1_deposited && !match.p2_deposited;
            const onlyP2Paid = match.p2_deposited && !match.p1_deposited;

            if (onlyP1Paid) {
                console.log(`⏰ TIMEOUT: Match ${match.contract_match_id} - P2 ghosted. Refunding P1.`);
                await refundPlayer(supabase, escrow, match, match.player1_address);
            } else if (onlyP2Paid) {
                console.log(`⏰ TIMEOUT: Match ${match.contract_match_id} - P1 ghosted. Refunding P2.`);
                await refundPlayer(supabase, escrow, match, match.player2_address);
            } else if (!match.p1_deposited && !match.p2_deposited) {
                // Neither paid, just cancel
                console.log(`⏰ TIMEOUT: Match ${match.contract_match_id} - No deposits. Cancelling.`);
                await supabase.from('matches').update({ status: 'CANCELLED' }).eq('id', match.id);
            }
        }
    }
}

async function refundPlayer(supabase, escrow, match, playerAddress) {
    try {
        const matchIdBytes32 = numericToBytes32(match.contract_match_id);

        // Check if there's actually money on-chain
        const contractMatch = await escrow.matches(matchIdBytes32);
        const pot = contractMatch[2];

        if (pot.toString() !== '0') {
            const tx = await escrow.refundMatch(matchIdBytes32, playerAddress);
            console.log(`   Refund TX: ${tx.hash}`);
            await tx.wait();
        }

        await supabase
            .from('matches')
            .update({ status: 'CANCELLED', payout_status: 'REFUNDED' })
            .eq('id', match.id);

    } catch (e) {
        console.error(`   Refund error for ${match.contract_match_id}:`, e.message);
    }
}

// ---------------------------------------------------------
// 4. FORFEIT MONITOR (Existing - Rage Quit Detector)
// ---------------------------------------------------------
async function checkForfeits(supabase) {
    const { data: matches, error } = await supabase
        .from('matches')
        .select('*')
        .eq('status', 'LIVE');

    if (error || !matches || matches.length === 0) return;

    const disconnectMatches = matches.filter(m => m.player1_disconnect_time || m.player2_disconnect_time);
    if (disconnectMatches.length === 0) return;

    const FORFEIT_TIMEOUT_MS = 5 * 60 * 1000;
    const now = Date.now();

    for (const match of disconnectMatches) {
        let winnerAddress = null;
        let disconnectTime = 0;

        if (match.player1_disconnect_time) {
            disconnectTime = new Date(match.player1_disconnect_time).getTime();
            if (now - disconnectTime > FORFEIT_TIMEOUT_MS) {
                winnerAddress = match.player2_address;
            }
        } else if (match.player2_disconnect_time) {
            disconnectTime = new Date(match.player2_disconnect_time).getTime();
            if (now - disconnectTime > FORFEIT_TIMEOUT_MS) {
                winnerAddress = match.player1_address;
            }
        }

        if (winnerAddress) {
            console.log(`🚨 AUTO-FORFEIT Match ${match.contract_match_id} | Winner: ${winnerAddress}`);
            await supabase.from('matches').update({
                status: 'COMPLETE',
                winner_address: winnerAddress,
                payout_status: 'PENDING'
            }).eq('id', match.id);

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
            console.error("RCON Error:", e.message);
        }
    }

    await supabase.from('game_servers').update({ status: 'FREE', current_match_id: null }).eq('id', server.id);
}

// ---------------------------------------------------------
// 5. PAYOUT PROCESSOR (Existing - Winner gets paid)
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
// MAIN LOOP
// ---------------------------------------------------------
async function run() {
    if (!PRIVATE_KEY) {
        console.error("ERROR: PAYOUT_PRIVATE_KEY not found in .env");
        process.exit(1);
    }

    console.log(`[${new Date().toISOString()}] Bot cycle starting...`);

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);

    try {
        // NEW: Verify deposits on-chain
        await verifyDeposits(supabase, provider);

        // NEW: Assign servers when both players paid
        await assignServers(supabase);

        // NEW: Cancel stale matches
        await checkTimeouts(supabase, escrow);

        // EXISTING: Check for forfeits (rage quits)
        await checkForfeits(supabase);

        // EXISTING: Process payouts
        await processPayouts(supabase, escrow);

    } catch (e) {
        console.error("Loop Error:", e);
    }
}

// Run
run();
