'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useState, useEffect, Suspense } from 'react';
import { useAccount } from 'wagmi';
import { parseUnits, Contract, BrowserProvider } from 'ethers';
import { supabase } from '@/lib/supabase';
import { USDC_ABI, ESCROW_ABI, numericToBytes32 } from '@/lib/abi';
import { MatchStatusBadge } from '@/components/MatchStatusBadge';
import { useMatchRecovery } from '@/hooks/useMatchRecovery';
import { useSearchParams } from 'next/navigation';
import VerificationGate from '@/components/VerificationGate';
import SteamIdentityBadge from '@/components/SteamIdentityBadge';

const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS!;
const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_ADDRESS!;
const DEPOSIT_AMOUNT = "5"; // 5 USDC

// Add 'usdc' to ABI to check the stored address
const DEBUG_ESCROW_ABI = [
  ...ESCROW_ABI,
  "function usdc() external view returns (address)"
];

function ArcadeInterface() {
  const { address, isConnected, connector } = useAccount();
  const searchParams = useSearchParams();
  const inviteMatchId = searchParams.get('match'); // ?match=123

  // Core State
  const [matchData, setMatchData] = useState<any>(null);
  const [logs, setLogs] = useState<string[]>([]);
  
  // UI Inputs
  const [steamData, setSteamData] = useState<{ id: string, name: string | null } | null>(null);
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

  // NEW: Handle Error Params
  useEffect(() => {
    const error = searchParams.get('error');
    if (error === 'steam_already_linked') {
        alert("🔒 This Steam account is already linked to another wallet. Please use a different Steam account or contact support.");
        window.history.replaceState({}, '', window.location.pathname);
    } else if (error === 'steam_failed') {
        alert("❌ Steam authentication failed. Please try again.");
        window.history.replaceState({}, '', window.location.pathname);
    } else if (error === 'missing_data') {
        alert("⚠️ Session expired or cookies blocked. Please try clicking the link button again.");
        window.history.replaceState({}, '', window.location.pathname);
    } else if (error === 'link_failed') {
        alert("❌ Database connection failed. Please try again.");
        window.history.replaceState({}, '', window.location.pathname);
    }
  }, [searchParams]);

  // NEW: Fetch Session-based Steam Data
  useEffect(() => {
    if (!address) {
      setSteamData(null);
      return;
    }

    const fetchSteamData = async () => {
      try {
        const res = await fetch(`/api/auth/sessions?wallet=${address}`);
        const data = await res.json();
        
        if (data.authenticated) {
          setSteamData({ id: data.steamId, name: data.steamName });
        } else {
          setSteamData(null);
        }
      } catch (e) {
        console.error('Session fetch error:', e);
        setSteamData(null);
      }
    };

    fetchSteamData();
  }, [address]);

  const [serverInfo, setServerInfo] = useState<{ ip: string, port: number, connect_command: string } | null>(null);

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
          
          if (payload.new.status === 'DEPOSITING' && matchData.status !== 'DEPOSITING') {
              addLog("Host started match! Deposit Phase Active.");
          }
          if (payload.new.status === 'LIVE' && matchData.status !== 'LIVE') {
              addLog("Match is LIVE! Go go go!");
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [matchData?.id, matchData?.status]); // Added status dependency

    // NEW: Fetch assigned server if match is LIVE (Persistence)
    useEffect(() => {
        if (matchData?.status === 'LIVE' && !serverInfo) {
            const fetchAssignedServer = async () => {
                const { data } = await supabase
                    .from('game_servers')
                    .select('ip, port')
                    .eq('current_match_id', matchData.id)
                    .single();
                
                if (data) {
                    setServerInfo({
                        ip: data.ip,
                        port: data.port,
                        connect_command: `connect ${data.ip}:${data.port}; password lmaololz`
                    });
                    setServerReady(true); // Assume ready if already assigned
                }
            };
            fetchAssignedServer();
        }
    }, [matchData?.status, matchData?.id]);


  // 3. ACTIONS
  const handleSteamLink = () => {
    if (!address) return alert("Connect Wallet First!");
    window.location.href = `/api/auth/steam/login?address=${address}`;
  };

  const createLobby = async () => {
      if (!steamData) return alert("Link Steam Account First!");
      setIsProcessing(true);
      
      // DUPLICATE PREVENTION: Check if user already has an active match
      const { data: existingMatch } = await supabase
          .from('matches')
          .select('*')
          .or(`player1_address.eq.${address},player2_address.eq.${address}`)
          .in('status', ['LOBBY', 'DEPOSITING', 'VERIFYING_PAYMENT', 'PENDING', 'LIVE'])
          .limit(1)
          .maybeSingle();

      if (existingMatch) {
          alert(`You already have an active match! (ID: ${existingMatch.contract_match_id})`);
          setMatchData(existingMatch);
          setIsProcessing(false);
          return;
      }
      
      const numericMatchId = Date.now();
      
      const { data, error } = await supabase
        .from('matches')
        .insert([{
            player1_address: address,
            player2_address: '0x0000000000000000000000000000000000000000',
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

  // 4. REFUND (New Feature)
  const handleRefund = async () => {
      if (!confirm("Are you sure you want to cancel this match and refund your deposit?")) return;
      setIsProcessing(true);
      addLog("Initiating Refund...");

      try {
          const res = await fetch('/api/match/refund', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                  matchId: matchData.id,
                  walletAddress: address
              })
          });

          const data = await res.json();

          if (!res.ok) throw new Error(data.error);

          alert("✅ Refund Successful! Your USDC has been returned.");
          window.location.reload();

      } catch (e: any) {
          console.error(e);
          alert("Refund Failed: " + e.message);
          setIsProcessing(false);
      }
  };

  // 5. DEPOSIT
  const startDepositPhase = async () => {
      addLog("Starting Deposit Phase...");
      await supabase
        .from('matches')
        .update({ status: 'DEPOSITING' })
        .eq('id', matchData.id);
  };

  const handleDeposit = async () => {
      if (!steamData) return alert("Link Steam Account First!");
      setIsProcessing(true);
      addLog("Starting Deposit Sequence...");

      try {
        // A. Save Steam ID
        const isPlayer1 = matchData.player1_address === address;
        const updateField = isPlayer1 ? 'player1_steam' : 'player2_steam';
        
        await supabase
            .from('matches')
            .update({ [updateField]: steamData.id })
            .eq('id', matchData.id);

        // B. Blockchain Transaction
        const walletProvider = await connector?.getProvider();
        if (!walletProvider) throw new Error("No wallet provider found");
        
        // @ts-ignore
        const provider = new BrowserProvider(walletProvider);
        const signer = await provider.getSigner();
        const usdc = new Contract(USDC_ADDRESS, USDC_ABI, signer);
        const escrow = new Contract(ESCROW_ADDRESS, DEBUG_ESCROW_ABI, signer);
        const amount = parseUnits(DEPOSIT_AMOUNT, 18); // Testnet "Fake USDC" uses 18 decimals

        // DEBUG: Verify Contract's USDC Address
        try {
            const contractUsdc = await escrow.usdc();
            console.log(`Frontend USDC: ${USDC_ADDRESS}`);
            console.log(`Contract USDC: ${contractUsdc}`);
            if (contractUsdc.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
                alert(`CRITICAL MISMATCH!\nContract expects USDC at: ${contractUsdc}\nFrontend using: ${USDC_ADDRESS}`);
                throw new Error("USDC Address Mismatch");
            }
        } catch (e) {
            console.error("Failed to verify contract USDC:", e);
        }

        // Approve
        const allowance = await usdc.allowance(address, ESCROW_ADDRESS);
        if (allowance < amount) {
            addLog("Approving USDC...");
            const tx = await usdc.approve(ESCROW_ADDRESS, amount);
            await tx.wait();
        }

        // Deposit
        addLog("Depositing 5 USDC...");
        const matchIdBytes32 = numericToBytes32(matchData.contract_match_id);
        const tx = await escrow.deposit(matchIdBytes32, amount, { gasLimit: 200000 });
        await tx.wait();
        addLog("Deposit Confirmed!");

        // C. Check if BOTH deposited to trigger LIVE
        // We check if both Steam IDs are now present in DB
        const { data: freshData } = await supabase.from('matches').select('*').eq('id', matchData.id).single();
        if (freshData.player1_steam && freshData.player2_steam) {
            addLog("Both Players Ready! Going LIVE...");
            await supabase.from('matches').update({ status: 'LIVE' }).eq('id', matchData.id);
        } else {
            addLog("Waiting for opponent to deposit...");
        }

      } catch (e: any) {
          console.error(e);
          addLog("Error: " + e.message);
      }
      setIsProcessing(false);
  };

  const prepareServer = async () => {
    if (!matchData) return;
    try {
        addLog("Finding a Server...");
        const res = await fetch('/api/match/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ matchId: matchData.id }) // Send matchId!
        });
        const data = await res.json();
        
        if (data.error) {
            addLog("Error: " + data.error);
            throw new Error(data.error);
        }
        
        // Update State with Assigned Server
        setServerInfo(data.server);
        setServerReady(true);
        addLog("Server Assigned: " + data.server.ip);
    } catch (e: any) {
        console.error(e);
        // alert(e.message); // Optional: don't alert if using logs
    }
  };



  // 4. VIEW LOGIC
  const renderView = () => {
      // LOADING GUARD: Wait for recovery check before showing any options
      if (recoveryLoading) {
          return (
              <div className="flex flex-col items-center gap-4 py-12">
                  <div className="w-12 h-12 border-4 border-green-500 border-t-transparent rounded-full animate-spin"></div>
                  <p className="text-gray-400">Checking for active matches...</p>
              </div>
          );
      }

      if (!matchData) {
          // VIEW_HOME
          return (
              <div className="flex flex-col gap-4">
                  {inviteMatchId ? (
                      <div className="bg-blue-900/30 p-8 rounded-3xl border border-blue-500/50 shadow-xl backdrop-blur-sm">
                          <h2 className="text-2xl font-bold mb-2">You're Invited!</h2>
                          <p className="text-sm text-blue-300 mb-6 font-mono opacity-80 underline decoration-dotted">MATCH #{inviteMatchId}</p>
                          <button 
                            onClick={joinLobby}
                            disabled={isProcessing}
                            className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 px-10 rounded-2xl text-xl w-full transition-all shadow-lg hover:scale-[1.02] active:scale-95 disabled:opacity-50"
                          >
                              {isProcessing ? "Joining..." : "JOIN NOW"}
                          </button>
                      </div>
                  ) : (
                      <button 
                        onClick={createLobby}
                        disabled={isProcessing}
                        className="bg-green-500 hover:bg-green-400 text-black font-black py-6 px-12 rounded-3xl text-2xl shadow-[0_0_40px_rgba(34,197,94,0.3)] transition-all hover:scale-105 active:scale-95 hover:shadow-[0_0_50px_rgba(34,197,94,0.5)] disabled:opacity-50"
                      >
                          {isProcessing ? "CREATING..." : "START NEW MATCH"}
                      </button>
                  )}
              </div>
          );
      }

      const isHost = matchData.player1_address === address;
      const hasP2 = matchData.player2_address && matchData.player2_address !== '0x0000000000000000000000000000000000000000';
      
      // UNIFIED LOBBY & DEPOSIT VIEW
      if (['LOBBY', 'PENDING', 'DEPOSITING'].includes(matchData.status)) {
          const p1Ready = !!matchData.player1_steam;
          const p2Ready = !!matchData.player2_steam;
          const isDepositing = matchData.status === 'DEPOSITING';
          
          // CONFLICT DETECTION
          const isWrongMatch = inviteMatchId && String(matchData.contract_match_id) !== String(inviteMatchId);

          return (
              <div className="w-full max-w-4xl flex flex-col gap-8">
                  {/* CONFLICT WARNING */}
                  {isWrongMatch && (
                      <div className="bg-red-900/50 border border-red-500 p-4 rounded-lg flex justify-between items-center animate-pulse">
                          <div>
                              <p className="font-bold text-red-200">⚠️ You are in a different match!</p>
                              <p className="text-xs text-red-300">Invite is for #{inviteMatchId}, but you are in #{matchData.contract_match_id}</p>
                          </div>
                          <button 
                            onClick={() => setMatchData(null)}
                            className="bg-red-600 hover:bg-red-500 text-white text-xs font-bold py-2 px-4 rounded"
                          >
                              LEAVE CURRENT MATCH
                          </button>
                      </div>
                  )}

                  {/* HEADER */}
                  <div className="flex justify-between items-center bg-gray-800/50 p-4 rounded-lg border border-gray-700">
                      <div>
                          <p className="text-xs text-gray-400">MATCH ID</p>
                          <p className="font-mono text-blue-400">{matchData.contract_match_id}</p>
                      </div>
                      <div className="text-right">
                          <p className="text-xs text-gray-400">STATUS</p>
                          <p className={`font-bold ${isDepositing ? 'text-yellow-400' : 'text-gray-300'}`}>
                              {isDepositing ? 'DEPOSIT PHASE' : 'WAITING FOR PLAYERS'}
                          </p>
                      </div>
                  </div>

                  {/* SPLIT VIEW */}
                  <div className="relative grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-12">
                      
                      {/* VS BADGE */}
                      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 hidden md:flex items-center justify-center w-16 h-16 bg-black border-2 border-gray-700 rounded-full shadow-xl">
                          <span className="text-2xl font-black italic text-gray-500">VS</span>
                      </div>

                      {/* PLAYER 1 (HOST) */}
                      <div className={`p-6 rounded-xl border-2 flex flex-col items-center gap-4 transition-all ${p1Ready ? 'bg-green-900/20 border-green-500/50' : 'bg-gray-800 border-gray-700'}`}>
                          <div className="w-20 h-20 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-2xl shadow-lg">
                              🤖
                          </div>
                          <div className="text-center">
                              <h3 className="font-bold text-lg">PLAYER 1</h3>
                              <p className="text-xs text-gray-400 font-mono">{matchData.player1_address.slice(0,6)}...{matchData.player1_address.slice(-4)}</p>
                          </div>
                          {isDepositing && (
                              <div className={`px-3 py-1 rounded text-xs font-bold ${p1Ready ? 'bg-green-500 text-black' : 'bg-yellow-500/20 text-yellow-500'}`}>
                                  {p1Ready ? 'READY' : 'DEPOSITING...'}
                              </div>
                          )}
                      </div>

                      {/* PLAYER 2 (GUEST) */}
                      <div className={`p-6 rounded-xl border-2 flex flex-col items-center gap-4 transition-all ${p2Ready ? 'bg-green-900/20 border-green-500/50' : 'bg-gray-800 border-gray-700'}`}>
                          <div className={`w-20 h-20 rounded-full flex items-center justify-center text-2xl shadow-lg ${hasP2 ? 'bg-gradient-to-br from-red-500 to-orange-600' : 'bg-gray-700 animate-pulse'}`}>
                              {hasP2 ? '👾' : '?'}
                          </div>
                          <div className="text-center">
                              <h3 className="font-bold text-lg">PLAYER 2</h3>
                              {hasP2 ? (
                                  <p className="text-xs text-gray-400 font-mono">{matchData.player2_address.slice(0,6)}...{matchData.player2_address.slice(-4)}</p>
                              ) : (
                                  <p className="text-xs text-gray-500 italic">Waiting to join...</p>
                              )}
                          </div>
                          {isDepositing && hasP2 && (
                              <div className={`px-3 py-1 rounded text-xs font-bold ${p2Ready ? 'bg-green-500 text-black' : 'bg-yellow-500/20 text-yellow-500'}`}>
                                  {p2Ready ? 'READY' : 'DEPOSITING...'}
                              </div>
                          )}
                      </div>
                  </div>

                  {/* ACTION AREA */}
                  <div className="bg-black/40 p-6 rounded-xl border border-gray-800 flex flex-col items-center gap-4">
                      {!hasP2 ? (
                          <div className="flex flex-col gap-4 w-full">
                            <p className="text-sm text-gray-400">Share this link with your opponent:</p>
                            <div className="bg-black/40 p-3 rounded font-mono text-xs select-all break-all border border-gray-700">
                                {`${window.location.origin}?match=${matchData.contract_match_id}`}
                            </div>
                            
                            {/* Cancel Button (Only for Creator) */}
                            {matchData.player1_address === address && (
                                <>
                                    {/* LOBBY Phase: No deposit yet - simple DB cancel */}
                                    {matchData.status === 'LOBBY' && (
                                        <button 
                                            onClick={async () => {
                                                if (!confirm("Cancel this match?")) return;
                                                setIsProcessing(true);
                                                await supabase.from('matches').update({ status: 'CANCELLED' }).eq('id', matchData.id);
                                                alert("Match cancelled.");
                                                window.location.reload();
                                            }}
                                            disabled={isProcessing}
                                            className="mt-4 text-xs text-gray-400 hover:text-gray-300 underline disabled:opacity-50"
                                        >
                                            {isProcessing ? "Cancelling..." : "Cancel Match"}
                                        </button>
                                    )}
                                    {/* DEPOSITING Phase: P1 deposited - blockchain refund needed */}
                                    {matchData.status === 'DEPOSITING' && p1Ready && (
                                        <button 
                                            onClick={handleRefund}
                                            disabled={isProcessing}
                                            className="mt-4 text-xs text-red-400 hover:text-red-300 underline disabled:opacity-50"
                                        >
                                            {isProcessing ? "Processing Refund..." : "Cancel & Refund Deposit"}
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                      ) : !isDepositing ? (
                          isHost ? (
                              <button 
                                  onClick={startDepositPhase}
                                  className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-8 rounded-lg w-full max-w-md shadow-lg shadow-blue-900/20"
                              >
                                  START DEPOSIT PHASE
                              </button>
                          ) : (
                              <p className="text-blue-400 animate-pulse font-bold">Waiting for Host to start...</p>
                          )
                      ) : (
                          // DEPOSIT FORM
                           <div className="w-full max-w-md flex flex-col gap-4">
                               {(isHost && p1Ready) || (!isHost && p2Ready) ? (
                                   <div className="text-center p-4 bg-green-900/20 border border-green-500/50 rounded-lg">
                                       <p className="text-green-400 font-bold mb-1">YOU ARE READY</p>
                                       <p className="text-xs text-gray-400">Waiting for opponent to deposit...</p>
                                   </div>
                               ) : (
                                   <>
                                       {steamData ? (
                                           <div className="bg-gray-900/50 border border-blue-500/30 p-4 rounded-xl flex items-center justify-between">
                                               <div className="flex flex-col">
                                                   <span className="text-xs text-blue-400 font-bold uppercase tracking-wider">Verified Identity</span>
                                                   <span className="text-white font-mono">{steamData.name || "Steam Connected"}</span>
                                               </div>
                                               <div className="h-2 w-2 rounded-full bg-green-500 shadow-[0_0_8px_#22c55e]"></div>
                                           </div>
                                       ) : (
                                            <button 
                                                onClick={handleSteamLink}
                                                className="bg-gray-800 hover:bg-gray-700 text-white border border-gray-600 p-4 rounded-xl transition-all flex items-center justify-center gap-3 group"
                                            >
                                                <span>🔗</span> Link Steam Account
                                            </button>
                                       )}
                                       
                                       <button 
                                           onClick={handleDeposit}
                                           disabled={isProcessing || !steamData}
                                           className="bg-green-500 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold py-4 px-6 rounded-xl w-full shadow-[0_0_15px_rgba(34,197,94,0.4)] transition-all"
                                       >
                                           {isProcessing ? "PROCESSING..." : "DEPOSIT 5 USDC"}
                                       </button>
                                   </>
                               )}
                           </div>
                      )}

                      <button 
                          onClick={async () => {
                              if(!confirm("Cancel this lobby?")) return;
                              const { error } = await supabase.from('matches').update({ status: 'CANCELLED' }).eq('id', matchData.id);
                              if (error) alert(error.message);
                              setMatchData(null);
                              window.history.pushState({}, '', window.location.pathname);
                          }}
                          className="mt-4 text-xs text-red-500 hover:text-red-400 underline"
                      >
                          Cancel Lobby
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
                  
                  {!serverReady || !serverInfo ? (
                      <button onClick={prepareServer} className="bg-white text-black font-bold py-3 px-6 rounded w-full mb-4">
                          1. FIND SERVER & START
                      </button>
                  ) : (
                      <div className="bg-black p-4 rounded border border-gray-700 font-mono text-sm text-left mb-4">
                          {serverInfo.connect_command}
                      </div>
                  )}
                  
                  {serverInfo && (
                      <button 
                          onClick={() => navigator.clipboard.writeText(serverInfo.connect_command)}
                          className="bg-green-600 hover:bg-green-500 text-white font-bold py-3 px-6 rounded w-full"
                      >
                          COPY CONNECT COMMAND
                      </button>
                  )}
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
      <header className="absolute top-4 right-4 flex gap-4 items-center">
        <SteamIdentityBadge />
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

        {isConnected ? (
          <VerificationGate>
            {renderView()}
          </VerificationGate>
        ) : (
          <p>Connect Wallet to Play</p>
        )}
        
        {/* DEBUG TOOLS */}
        {isConnected && (
            <div className="mt-12 pt-8 border-t border-gray-800 w-full text-center">
                <p className="text-xs text-gray-600 mb-2">DEBUG ZONE</p>
                <button 
                    onClick={async () => {
                        if(!confirm("⚠️ NUKE: This will cancel ALL your active matches. Are you sure?")) return;
                        const { error } = await supabase
                            .from('matches')
                            .update({ status: 'CANCELLED' })
                            .or(`player1_address.eq.${address},player2_address.eq.${address}`)
                            .in('status', ['LOBBY', 'PENDING', 'DEPOSITING', 'LIVE']);
                        
                        if (error) alert("Nuke failed: " + error.message);
                        else {
                            alert("💥 All active matches cancelled.");
                            window.location.reload();
                        }
                    }}
                    className="text-xs text-red-900 hover:text-red-500 underline"
                >
                    [DEBUG] Force Cancel All My Matches
                </button>
            </div>
        )}
      </main>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">Loading Arcade...</div>}>
      <ArcadeInterface />
    </Suspense>
  );
}
