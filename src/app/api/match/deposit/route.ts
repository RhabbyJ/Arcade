import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ethers } from 'ethers';
import { maybeStartDatHostMatch } from '@/lib/maybeStartDatHostMatch';

/**
 * POST /api/match/deposit
 * 
 * Saves the tx_hash to DB, verifies on-chain, and triggers DatHost match
 * when both deposits are verified.
 */

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://sepolia.base.org");

// Escrow contract ABI for deposit verification
const ESCROW_ABI = [
    "event Deposit(bytes32 indexed matchId, address indexed player, uint256 amount)"
];

async function verifyDepositOnChain(txHash: string, expectedPlayer: string): Promise<{ verified: boolean; error?: string }> {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);

        if (!receipt) {
            return { verified: false, error: "Transaction not found or pending" };
        }

        if (receipt.status !== 1) {
            return { verified: false, error: "Transaction reverted" };
        }

        // Optionally verify the Deposit event
        const escrowAddress = process.env.ESCROW_ADDRESS || process.env.NEXT_PUBLIC_ESCROW_ADDRESS;
        if (escrowAddress) {
            const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
            const depositEvents = receipt.logs
                .filter(log => log.address.toLowerCase() === escrowAddress.toLowerCase())
                .map(log => {
                    try {
                        return escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
                    } catch {
                        return null;
                    }
                })
                .filter(e => e && e.name === "Deposit");

            if (depositEvents.length === 0) {
                return { verified: false, error: "No Deposit event found" };
            }

            // Verify the depositor matches expected player
            const depositEvent = depositEvents[0];
            if (depositEvent && depositEvent.args.player.toLowerCase() !== expectedPlayer.toLowerCase()) {
                return { verified: false, error: "Deposit player mismatch" };
            }
        }

        return { verified: true };
    } catch (err: any) {
        return { verified: false, error: err.message || "Verification failed" };
    }
}

export async function POST(req: NextRequest) {
    try {
        const { matchId, walletAddress, txHash } = await req.json();

        if (!matchId || !walletAddress || !txHash) {
            return NextResponse.json(
                { error: "Missing required fields: matchId, walletAddress, txHash" },
                { status: 400 }
            );
        }

        // 1. Fetch the match
        const { data: match, error: fetchError } = await supabaseAdmin
            .from('matches')
            .select('*')
            .eq('id', matchId)
            .single();

        if (fetchError || !match) {
            return NextResponse.json({ error: "Match not found" }, { status: 404 });
        }

        // 2. Check if match is still accepting deposits
        if (!['LOBBY', 'DEPOSITING', 'WAITING_FOR_DEPOSITS'].includes(match.status)) {
            return NextResponse.json({
                error: `Match is ${match.status}. Cannot accept deposits.`
            }, { status: 400 });
        }

        // 3. Determine which player is depositing
        const isPlayer1 = match.player1_address?.toLowerCase() === walletAddress.toLowerCase();
        const isPlayer2 = match.player2_address?.toLowerCase() === walletAddress.toLowerCase();

        if (!isPlayer1 && !isPlayer2) {
            return NextResponse.json({ error: "You are not a player in this match" }, { status: 403 });
        }

        // 4. Check if already deposited
        const txField = isPlayer1 ? 'p1_tx_hash' : 'p2_tx_hash';
        const verifiedField = isPlayer1 ? 'p1_deposit_verified' : 'p2_deposit_verified';

        if ((isPlayer1 && match.p1_deposit_verified) || (isPlayer2 && match.p2_deposit_verified)) {
            return NextResponse.json({ error: "Already deposited and verified" }, { status: 400 });
        }

        // 5. Save tx_hash first
        const isFirstDeposit = match.status !== 'DEPOSITING';
        await supabaseAdmin
            .from('matches')
            .update({
                [txField]: txHash,
                status: 'DEPOSITING',
                ...(isFirstDeposit && { deposit_started_at: new Date().toISOString() })
            })
            .eq('id', matchId);

        console.log(`[Deposit API] Saved ${txField} for match ${matchId}: ${txHash}`);

        // 6. Verify on-chain
        const verification = await verifyDepositOnChain(txHash, walletAddress);

        if (!verification.verified) {
            console.log(`[Deposit API] Verification pending: ${verification.error}`);
            return NextResponse.json({
                success: true,
                verified: false,
                message: `Transaction saved. Verification: ${verification.error}`,
                player: isPlayer1 ? 'player1' : 'player2',
                txHash
            });
        }

        // 7. Mark as verified
        await supabaseAdmin
            .from('matches')
            .update({ [verifiedField]: true })
            .eq('id', matchId);

        console.log(`[Deposit API] ✅ ${verifiedField} = true for match ${matchId}`);

        // 8. Try to start DatHost match (if both verified)
        const startResult = await maybeStartDatHostMatch(matchId);

        if (startResult.started) {
            console.log(`[Deposit API] 🚀 DatHost match started: ${startResult.dathost_match_id}`);
        } else {
            console.log(`[Deposit API] DatHost not started: ${startResult.reason}`);
        }

        return NextResponse.json({
            success: true,
            verified: true,
            message: "Deposit verified on-chain",
            player: isPlayer1 ? 'player1' : 'player2',
            txHash,
            dathostStarted: startResult.started,
            dathostReason: startResult.reason
        });

    } catch (e: any) {
        console.error("[Deposit API] Error:", e);
        return NextResponse.json({ error: e.message || "Unknown error" }, { status: 500 });
    }
}
