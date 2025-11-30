'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { parseUnits, Contract, formatUnits, BrowserProvider } from 'ethers';
import { supabase } from '@/lib/supabase';
import { USDC_ABI, ESCROW_ABI } from '@/lib/abi';
import { MatchStatusBadge } from '@/components/MatchStatusBadge';
import { useMatchRecovery } from '@/hooks/useMatchRecovery';
import { useSearchParams } from 'next/navigation';

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
  const searchParams = useSearchParams();
  const inviteMatchId = searchParams.get('match'); // ?match=123

  // Core State
  const [matchData, setMatchData] = useState<any>(null);
  const [logs, setLogs] = useState<string[]>([]);
  
  // UI Inputs
  const [steamId, setSteamId] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [serverReady, setServerReady] = useState(false);

  // Recovery Hook
  const { recoveredMatch, loading: recoveryLoading } = useMatchRecovery();

  const addLog = (msg: string) => setLogs(prev => [...prev, msg]);

  // 1. RECOVERY & SYNC
  useEffect(() => {
    if (recoveredMatch) {
      console.log("Syncing State from Recovery:", recoveredMatch);
      setMatchData(recoveredMatch);
    }
  }, [recoveredMatch]);

  // 2. REALTIME UPDATES
  useEffect(() => {
    if (!matchData?.id) return;

    const channel = supabase
      .channel('match-updates')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'matches',
          filter: `id=eq.${matchData.id}`,
        },
        (payload) => {
          console.log('Realtime Update:', payload.new);
          setMatchData(payload.new);
          
          if (payload.new.status === 'LIVE' && matchData.status !== 'LIVE') {
              addLog("Match is LIVE! Go go go!");
          }
          if (payload.new.status === 'COMPLETE' && matchData.status !== 'COMPLETE') {
              addLog("Match Complete! Checking winner...");
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [matchData?.id]);


  // 3. ACTIONS
  const createLobby = async () => {
      setIsProcessing(true);
      const numericMatchId = Date.now();
      
      const { data, error } = await supabase
        .from('matches')
        .insert([{
            player1_address: address,
            status: 'LOBBY',
            contract_match_id: numericMatchId,
            payout_status: 'PENDING'
        }])
        .select()
        .single();
        
      if (error) {
          alert("Failed to create lobby: " + error.message);
      } else {
          setMatchData(data);
          addLog(`Lobby Created (ID: ${numericMatchId})`);
      }
      setIsProcessing(false);
  };

  const joinLobby = async () => {
      if (!inviteMatchId) return;
      setIsProcessing(true);
      
      // Find the match first to get the UUID
      const { data: existingMatch, error: fetchError } = await supabase
        .from('matches')
        .select('*')
        .eq('contract_match_id', inviteMatchId)
        .single();

      if (fetchError || !existingMatch) {
          alert("Match not found!");
          setIsProcessing(false);
          return;
      }

      const { data, error } = await supabase
        .from('matches')
        .update({ player2_address: address })
        .eq('id', existingMatch.id)
        .select()
        .single();

      if (error) {
          alert("Failed to join: " + error.message);
      } else {
          setMatchData(data);
          addLog("Joined Lobby!");
      }
      setIsProcessing(false);
  };

  const handleDeposit = async () => {
      if (!steamId) return alert("Enter Steam ID first!");
      setIsProcessing(true);
      addLog("Starting Deposit Sequence...");

      try {
        // A. Save Steam ID
        const isPlayer1 = matchData.player1_address === address;
        const updateField = isPlayer1 ? 'player1_steam' : 'player2_steam';
        
        await supabase
            .from('matches')
            .update({ [updateField]: steamId })
            .eq('id', matchData.id);

        // B. Blockchain Transaction
        const provider = new BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();
        const usdc = new Contract(USDC_ADDRESS, USDC_ABI, signer);
        const escrow = new Contract(ESCROW_ADDRESS, DEBUG_ESCROW_ABI, signer);
        const amount = parseUnits(DEPOSIT_AMOUNT, 18);

        // Approve
        const allowance = await usdc.allowance(address, ESCROW_ADDRESS);
        if (allowance < amount) {
            addLog("Approving USDC...");
            const tx = await usdc.approve(ESCROW_ADDRESS, amount);
            await tx.wait();
        }

        // Deposit
        addLog("Depositing 5 USDC...");
        const tx = await escrow.deposit(matchData.contract_match_id, amount, { gasLimit: 200000 });
        await tx.wait();
        addLog("Deposit Confirmed!");

        // C. Update Status (Optimistic - In real app, backend should listen to events)
        // For MVP, if BOTH have Steam IDs (meaning both tried to deposit), we set LIVE
        // Actually, safer to just wait for manual refresh or backend. 
        // But let's set 'PENDING' -> 'LIVE' logic here?
        // Better: Just wait. If I am the second depositor, I can trigger LIVE.
        
        // Check if other player has deposited? We can't easily know on-chain without provider calls.
        // Simplified: If both Steam IDs are present in DB, assume ready?
        // Let's just update our Steam ID and let the backend/realtime handle the rest.
        // Wait, we need to trigger LIVE state.
        
        // MVP HACK: If I am the second person to add Steam ID, set status to LIVE.
        const { data: freshData } = await supabase.from('matches').select('*').eq('id', matchData.id).single();
        if (freshData.player1_steam && freshData.player2_steam) {
            await supabase.from('matches').update({ status: 'LIVE' }).eq('id', matchData.id);
        }

      } catch (e: any) {
          console.error(e);
          addLog("Error: " + e.message);
      }
      setIsProcessing(false);
  };

  const prepareServer = async () => {
    addLog("Resetting Server...");
    await fetch('/api/match/start', { method: 'POST' });
    setServerReady(true);
    addLog("Server Ready!");
  };

  // 4. VIEW LOGIC
  const renderView = () => {
      if (!matchData) {
          // VIEW_HOME
          return (
              <div className="flex flex-col gap-4">
                  {inviteMatchId ? (
                      <div className="bg-blue-900/30 p-6 rounded-xl border border-blue-500">
                          <h2 className="text-xl font-bold mb-2">You have been invited!</h2>
                          <p className="text-sm text-gray-400 mb-4">Match #{inviteMatchId}</p>
                          <button 
                            onClick={joinLobby}
                            disabled={isProcessing}
                            className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-8 rounded-lg w-full"
                          >
                              {isProcessing ? "Joining..." : "JOIN MATCH"}
                          </button>
                      </div>
                  ) : (
                      <button 
                        onClick={createLobby}
                        disabled={isProcessing}
                        className="bg-green-500 hover:bg-green-600 text-black font-bold py-4 px-8 rounded-xl text-xl"
                      >
                          {isProcessing ? "Creating..." : "CREATE MATCH"}
                      </button>
                  )}
              </div>
          );
      }

      // Helper: Check if a REAL Player 2 exists (not null, not zero-address)
      const hasP2 = matchData.player2_address && matchData.player2_address !== '0x0000000000000000000000000000000000000000';
      const isHost = matchData.player1_address === address;

      // VIEW_LOBBY (Waiting for P2) or PENDING (Legacy/Transition)
      if ((matchData.status === 'LOBBY' || matchData.status === 'PENDING') && !hasP2) {
          return (
              <div className="bg-gray-800 p-8 rounded-xl border border-gray-700">
                  <h2 className="text-2xl font-bold mb-4">LOBBY CREATED</h2>
                  <p className="text-gray-400 mb-6">Waiting for Player 2...</p>
                  <div className="bg-black/50 p-4 rounded border border-gray-600 flex gap-2">
                      <code className="flex-1 text-left text-sm text-gray-300">
                          {window.location.origin}?match={matchData.contract_match_id}
                      </code>
                      <button 
                        onClick={() => navigator.clipboard.writeText(`${window.location.origin}?match=${matchData.contract_match_id}`)}
                        className="text-xs bg-blue-600 px-3 py-1 rounded"
                      >
                          COPY
                      </button>
                  </div>
                  <button onClick={() => setMatchData(null)} className="mt-8 text-xs text-red-500 underline">
                      Exit Lobby (Clear Local State)
                  </button>
              </div>
          );
      }

      // VIEW_DEPOSIT (Both Players Present)
      if ((matchData.status === 'LOBBY' || matchData.status === 'PENDING') && hasP2) {
          return (
              <div className="bg-gray-800 p-8 rounded-xl border border-blue-500">
                  <h2 className="text-2xl font-bold mb-2">MATCH FOUND!</h2>
                  <p className="text-gray-400 mb-6">Both players are ready. Deposit to start.</p>
                  
                  <div className="flex flex-col gap-4">
                      <input 
                        type="text" 
                        placeholder="Enter Steam ID (e.g. 7656...)"
                        className="bg-black/50 border border-gray-600 p-3 rounded text-white"
                        value={steamId}
                        onChange={(e) => setSteamId(e.target.value)}
                      />
                      <button 
                        onClick={handleDeposit}
                        disabled={isProcessing}
                        className="bg-green-500 hover:bg-green-600 text-black font-bold py-3 px-6 rounded-lg"
                      >
                          {isProcessing ? "PROCESSING..." : "DEPOSIT 5 USDC"}
                      </button>
                  </div>
              </div>
          );
      }

      // VIEW_LIVE
      if (matchData.status === 'LIVE') {
          return (
              <div className="bg-gray-800 p-6 rounded-xl border border-green-500 shadow-xl w-full">
                  <MatchStatusBadge status="LIVE" />
                  <h2 className="text-2xl font-bold my-4 text-green-400">MATCH IS LIVE</h2>
                  
                  {!serverReady ? (
                      <button onClick={prepareServer} className="bg-white text-black font-bold py-3 px-6 rounded w-full mb-4">
                          1. RESET SERVER
                      </button>
                  ) : (
                      <div className="bg-black p-4 rounded border border-gray-700 font-mono text-sm text-left mb-4">
                          connect blindspot.dathost.net:26893; password lmaololz
                      </div>
                  )}
                  
                  <button 
                    onClick={() => navigator.clipboard.writeText("connect blindspot.dathost.net:26893; password lmaololz")}
                    className="bg-green-600 hover:bg-green-500 text-white font-bold py-3 px-6 rounded w-full"
                  >
                      COPY CONNECT COMMAND
                  </button>
              </div>
          );
      }

      // VIEW_WINNER
      if (matchData.status === 'COMPLETE' || matchData.status === 'PAID') {
          return (
              <div className="bg-gray-800 p-8 rounded-xl border border-yellow-500 text-center">
                  <h2 className="text-4xl font-black text-yellow-400 mb-4">GAME OVER</h2>
                  <p className="text-xl text-white mb-6">Winner: {matchData.winner_address?.slice(0,6)}...</p>
                  <div className="bg-black/50 p-4 rounded">
                      Status: <span className="text-green-400">{matchData.payout_status}</span>
                  </div>
                  <button onClick={() => window.location.href = '/'} className="mt-6 text-gray-400 underline">
                      Back to Home
                  </button>
              </div>
          );
      }

      return (
        <div className="flex flex-col gap-4">
            <p>Unknown State: {matchData.status}</p>
            <button onClick={() => setMatchData(null)} className="text-red-500 underline">
                Force Reset
            </button>
        </div>
      );
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
        
        {/* LOGS */}
        <div className="w-full bg-black/50 p-4 rounded-lg font-mono text-xs text-left h-32 overflow-y-auto border border-gray-800">
            {logs.map((log, i) => <div key={i} className="text-green-400">{`> ${log}`}</div>)}
        </div>

        {isConnected ? renderView() : <p>Connect Wallet to Play</p>}
      </main>
    </div>
  );
}
