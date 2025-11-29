'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useState } from 'react';
import { useAccount } from 'wagmi';
import { parseUnits, Contract, formatUnits } from 'ethers';
import { supabase } from '@/lib/supabase';
import { USDC_ABI, ESCROW_ABI } from '@/lib/abi';
import { BrowserProvider } from 'ethers';

const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS!;
const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_ADDRESS!;
const DEPOSIT_AMOUNT = "5"; // 5 USDC

// Add 'usdc' to ABI to check the stored address
const DEBUG_ESCROW_ABI = [
  ...ESCROW_ABI,
  "function usdc() external view returns (address)"
];

export default function Home() {
  const { address, isConnected } = useAccount();
  const [matchStatus, setMatchStatus] = useState<string>('IDLE');
  const [matchId, setMatchId] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = (msg: string) => setLogs(prev => [...prev, msg]);

  const handleDeposit = async () => {
    if (!address || !window.ethereum) return;
    
    try {
      setMatchStatus('DEPOSITING');
      addLog("Initializing Match...");

      // 1. Generate Match ID
      const numericMatchId = Date.now();
      
      // 2. Insert into Supabase
      const { data: matchData, error: dbError } = await supabase
        .from('matches')
        .insert([
          {
            player1_address: address,
            player2_address: '0x0000000000000000000000000000000000000000',
            status: 'PENDING',
            payout_status: 'PENDING',
            contract_match_id: numericMatchId,
          },
        ])
        .select()
        .single();

      if (dbError) throw new Error(`DB Error: ${dbError.message}`);
      setMatchId(matchData.id);
      addLog(`Match Created in DB (ID: ${numericMatchId})`);

      // 3. Ethers Setup
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      
      const usdc = new Contract(USDC_ADDRESS, USDC_ABI, signer);
      const escrow = new Contract(ESCROW_ADDRESS, DEBUG_ESCROW_ABI, signer);
      const amount = parseUnits(DEPOSIT_AMOUNT, 18);

      // DEBUG: Check Contract Configuration
      const storedUsdcAddress = await escrow.usdc();
      addLog(`DEBUG: Escrow uses USDC: ${storedUsdcAddress}`);
      if (storedUsdcAddress.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
        throw new Error("MISMATCH: Escrow contract is using the wrong USDC address! Redeploy Escrow.");
      }

      // 4. Approve
      addLog("Checking Allowance...");
      const currentAllowance = await usdc.allowance(address, ESCROW_ADDRESS);
      addLog(`Current Allowance: ${formatUnits(currentAllowance, 18)}`);

      if (currentAllowance < amount) {
        addLog("Requesting Approval...");
        const approveTx = await usdc.approve(ESCROW_ADDRESS, amount);
        addLog(`Approval Tx Sent: ${approveTx.hash}`);
        await approveTx.wait();
        addLog("Approval Confirmed.");
      } else {
        addLog("Allowance sufficient.");
      }

      // 5. Deposit
      addLog("Requesting Deposit...");
      // Manual gas limit to avoid estimation errors masking the real revert reason
      const depositTx = await escrow.deposit(numericMatchId, amount, { gasLimit: 200000 }); 
      addLog(`Deposit Tx Sent: ${depositTx.hash}`);
      await depositTx.wait();
      addLog("Deposit Confirmed!");

      setMatchStatus('PENDING');

    } catch (e: any) {
      console.error(e);
      addLog(`Error: ${e.message || e}`);
      setMatchStatus('IDLE');
    }
  };

  const launchGame = async () => {
    try {
      addLog("Resetting Server Scoreboard...");
      const res = await fetch('/api/match/start', { method: 'POST' });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to reset server');
      }
      
      addLog("Server Reset! Launching CS2...");
      
      // Give it a second to process
      setTimeout(() => {
        window.location.href = 'steam://connect/123.456.78.90:27015/password123';
      }, 1000);
      
    } catch (e: any) {
      console.error(e);
      addLog(`Error: ${e.message}`);
      // We might still want to launch even if reset fails? 
      // For now, let's block it so they know something is wrong.
      alert("Failed to reset server. Check console.");
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-8 font-[family-name:var(--font-geist-sans)]">
      <header className="absolute top-4 right-4">
        <ConnectButton />
      </header>

      <main className="flex flex-col gap-8 items-center text-center max-w-2xl w-full">
        <h1 className="text-5xl font-bold tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-600">
          DIGITAL ARCADE
        </h1>
        <p className="text-xl text-gray-400">1v1 CS2 Wagering. Winner Takes All.</p>

        {isConnected ? (
          <div className="flex flex-col gap-4 w-full">
            
            {/* LOGS CONSOLE */}
            <div className="bg-black/50 p-4 rounded-lg font-mono text-xs text-left h-32 overflow-y-auto border border-gray-800">
              {logs.map((log, i) => <div key={i} className="text-green-400">{`> ${log}`}</div>)}
              {logs.length === 0 && <span className="text-gray-600">System Ready...</span>}
            </div>

            {matchStatus === 'IDLE' && (
              <button
                onClick={handleDeposit}
                className="bg-green-500 hover:bg-green-600 text-black font-bold py-4 px-8 rounded-xl transition-all transform hover:scale-105"
              >
                DEPOSIT 5 USDC
              </button>
            )}

            {matchStatus === 'DEPOSITING' && (
              <div className="animate-pulse text-yellow-400 font-bold">
                PROCESSING TRANSACTION...
              </div>
            )}

            {matchStatus === 'PENDING' && (
              <div className="bg-gray-800 p-6 rounded-xl border border-gray-700">
                <h2 className="text-2xl font-bold mb-4">Match Created</h2>
                <p className="mb-4 text-gray-400">Waiting for opponent...</p>
                <button
                  onClick={() => setMatchStatus('LIVE')} // Simulate opponent join
                  className="bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded"
                >
                  (Simulate Opponent Join)
                </button>
              </div>
            )}

            {matchStatus === 'LIVE' && (
              <div className="bg-gray-800 p-6 rounded-xl border border-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.5)]">
                <h2 className="text-2xl font-bold mb-4 text-blue-400">MATCH LIVE</h2>
                <button
                  onClick={launchGame}
                  className="bg-white text-black font-bold py-3 px-6 rounded-lg hover:bg-gray-200 w-full mb-4"
                >
                  LAUNCH CS2
                </button>
                <p className="text-sm text-gray-500">Server: 123.456.78.90:27015</p>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-gray-800 p-8 rounded-2xl border border-gray-700">
            <p className="text-lg mb-4">Connect your wallet to enter the arena.</p>
          </div>
        )}
      </main>
    </div>
  );
}
