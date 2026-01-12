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

// Ready Check Countdown Timer (45 seconds)
const READY_TIMEOUT_MS = 45 * 1000; // 45 seconds to ready up

function ReadyTimer({ startedAt }: { startedAt: string | null }) {
    const [timeLeft, setTimeLeft] = useState<number>(READY_TIMEOUT_MS);

    useEffect(() => {
        if (!startedAt) return;
        
        const calculateTimeLeft = () => {
            const started = new Date(startedAt).getTime();
            const deadline = started + READY_TIMEOUT_MS;
            const remaining = Math.max(0, deadline - Date.now());
            setTimeLeft(remaining);
        };

        calculateTimeLeft();
        const interval = setInterval(calculateTimeLeft, 1000);
        return () => clearInterval(interval);
    }, [startedAt]);

    const seconds = Math.floor(timeLeft / 1000);
    const isUrgent = timeLeft < 15 * 1000; // Less than 15 seconds

    if (!startedAt) return null;

    if (timeLeft === 0) {
        return (
            <div className="text-center text-red-400 text-sm animate-pulse">
                ⏰ READY CHECK EXPIRED
            </div>
        );
    }

    return (
        <div className="text-center">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Ready within</p>
            <p className={`font-mono text-2xl font-bold ${isUrgent ? 'text-red-400 animate-pulse' : 'text-yellow-400'}`}>
                {seconds}s
            </p>
        </div>
    );
}

// Deposit Countdown Timer Component
const DEPOSIT_TIMEOUT_MS = 30 * 1000; // 30 seconds for testing (change to 10 * 60 * 1000 for production)

function DepositTimer({ startedAt }: { startedAt: string | null }) {
    const [timeLeft, setTimeLeft] = useState<number>(DEPOSIT_TIMEOUT_MS);

    useEffect(() => {
        if (!startedAt) return; // Wait until deposit phase starts
        
        const calculateTimeLeft = () => {
            const started = new Date(startedAt).getTime();
            const deadline = started + DEPOSIT_TIMEOUT_MS;
            const remaining = Math.max(0, deadline - Date.now());
            setTimeLeft(remaining);
        };

        calculateTimeLeft();
        const interval = setInterval(calculateTimeLeft, 1000);
        return () => clearInterval(interval);
    }, [startedAt]);

    const minutes = Math.floor(timeLeft / 60000);
    const seconds = Math.floor((timeLeft % 60000) / 1000);
    const isUrgent = timeLeft < 2 * 60 * 1000; // Less than 2 minutes

    if (!startedAt) {
        return (
            <div className="text-center">
                <p className="text-xs text-gray-400">TIME TO DEPOSIT</p>
                <p className="font-mono text-xl font-bold text-green-400">00:30</p>
            </div>
        );
    }

    if (timeLeft === 0) {
        return (
            <div className="text-center">
                <p className="text-xs text-red-400">TIME EXPIRED</p>
                <p className="text-red-500 font-bold">MATCH TIMING OUT</p>
            </div>
        );
    }

    return (
        <div className="text-center">
            <p className="text-xs text-gray-400">TIME TO DEPOSIT</p>
            <p className={`font-mono text-xl font-bold ${isUrgent ? 'text-red-400 animate-pulse' : 'text-green-400'}`}>
                {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
            </p>
        </div>
    );
}

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
          console.log('🔴 Realtime Update:', payload.new);
          const newData = payload.new as any;
          setMatchData(newData);
          
          // Log status transitions
          if (newData.status !== matchData.status) {
              console.log(`📊 Status changed: ${matchData.status} → ${newData.status}`);
              addLog(`Match status: ${newData.status}`);
          }
          
          if (newData.status === 'LIVE') {
              addLog("🚀 Match is LIVE! Server is ready!");
          }
          
          // Handle CANCELLED - show Tombstone UI (don't clear matchData)
          if (newData.status === 'CANCELLED') {
              addLog("❌ Match was cancelled or timed out.");
              // matchData stays set so Tombstone UI renders
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

  // Auto-start deposit phase when BOTH players are ready
  useEffect(() => {
      if (!matchData || !address) return;
      
      const isHost = matchData.player1_address?.toLowerCase() === address.toLowerCase();
      const bothReady = matchData.p1_ready && matchData.p2_ready;
      const notDepositing = matchData.status !== 'DEPOSITING';
      
      // Only host triggers the transition, and only if both ready and not already depositing
      if (isHost && bothReady && notDepositing && matchData.status === 'LOBBY') {
          console.log('🚀 Both ready! Auto-starting deposit phase...');
          const startDeposit = async () => {
              await fetch('/api/match/start-deposit', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify({ matchId: matchData.id })
              });
          };
          startDeposit();
      }
  }, [matchData?.p1_ready, matchData?.p2_ready, matchData?.status, matchData?.id, address]);


  // 3. ACTIONS
  const handleSteamLink = () => {
    if (!address) return alert("Connect Wallet First!");
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/api/auth/steam/login?address=${address}&returnTo=${returnTo}`;
  };

  const createLobby = async () => {
      if (!steamData) return alert("Link Steam Account First!");
      setIsProcessing(true);
      
      try {
          const res = await fetch('/api/match/create', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include'
          });
          
          const data = await res.json();
          
          if (!res.ok) {
              alert(data.error || "Failed to create lobby");
              if (data.existingMatch) setMatchData(data.existingMatch);
          } else {
              setMatchData(data.match);
              addLog(`Lobby Created (ID: ${data.match.contract_match_id})`);
          }
      } catch (e: any) {
          alert("Failed to create lobby: " + e.message);
      }
      setIsProcessing(false);
  };

  const joinLobby = async () => {
      if (!inviteMatchId) return;
      setIsProcessing(true);
      
      try {
          const res = await fetch('/api/match/join', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ matchId: inviteMatchId })
          });
          
          const data = await res.json();
          
          if (!res.ok) {
              alert(data.error || "Failed to join");
          } else {
              setMatchData(data.match);
              addLog("Joined Lobby! Ready Check started.");
          }
      } catch (e: any) {
          alert("Failed to join: " + e.message);
      }
      setIsProcessing(false);
  };

  // Leave Lobby - Host cancels, Guest leaves
  const leaveLobby = async () => {
      if (!matchData) return;
      
      const isHost = matchData.player1_address?.toLowerCase() === address?.toLowerCase();
      const msg = isHost ? "Cancel this match? Both players will be returned to lobby." : "Leave this match?";
      
      if (!confirm(msg)) return;
      
      try {
          const res = await fetch('/api/match/leave', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ matchId: matchData.id })
          });
          
          const data = await res.json();
          
          if (!res.ok) {
              alert(data.error || "Failed to leave");
          } else {
              setMatchData(null);
              addLog(data.message);
          }
      } catch (e: any) {
          alert("Failed to leave: " + e.message);
      }
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
      console.log("🚀 Starting Deposit Phase...");
      addLog("Starting Deposit Phase...");
      try {
          const res = await fetch('/api/match/start-deposit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ matchId: matchData.id })
          });
          if (!res.ok) {
              const data = await res.json();
              console.error("❌ Failed to start deposit:", data.error);
          } else {
              console.log("✅ Deposit phase started");
          }
      } catch (e) {
          console.error("❌ Failed to start deposit:", e);
      }
  };

  // Ready Check - player confirms they're ready before deposit phase
  const handleReady = async () => {
      if (!address || !matchData) return;
      
      console.log(`🎮 Setting ready status...`);
      try {
          const res = await fetch('/api/match/ready', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ matchId: matchData.id })
          });
          
          if (!res.ok) {
              const data = await res.json();
              console.error("❌ Failed to set ready:", data.error);
          } else {
              addLog("You are READY!");
          }
      } catch (e) {
          console.error("❌ Failed to set ready:", e);
      }
  };

  const handleDeposit = async () => {
      if (!steamData) return alert("Link Steam Account First!");
      setIsProcessing(true);
      addLog("Starting Deposit Sequence...");

      try {
        // Steam ID is already saved during create/join via API

        // B. Blockchain Transaction
        const walletProvider = await connector?.getProvider();
        if (!walletProvider) throw new Error("No wallet provider found");
        
        // @ts-ignore
        const provider = new BrowserProvider(walletProvider);
        const signer = await provider.getSigner();
        const usdc = new Contract(USDC_ADDRESS, USDC_ABI, signer);
        const escrow = new Contract(ESCROW_ADDRESS, DEBUG_ESCROW_ABI, signer);
        const amount = parseUnits(DEPOSIT_AMOUNT, 18); // Testnet "Fake USDC" uses 18 decimals

        // Approve
        const allowance = await usdc.allowance(address, ESCROW_ADDRESS);
        if (allowance < amount) {
            addLog("Approving USDC...");
            const tx = await usdc.approve(ESCROW_ADDRESS, amount);
            await tx.wait();
        }

        // Deposit to Contract
        addLog("Depositing 5 USDC...");
        const matchIdBytes32 = numericToBytes32(matchData.contract_match_id);
        const tx = await escrow.deposit(matchIdBytes32, amount, { gasLimit: 200000 });
        addLog("Transaction sent, waiting for confirmation...");
        await tx.wait();
        addLog("Deposit Confirmed on Blockchain!");

        // C. Submit TX Hash to API (Bot will verify on-chain)
        addLog("Sending proof to server...");
        const res = await fetch('/api/match/deposit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                matchId: matchData.id,
                walletAddress: address,
                txHash: tx.hash
            })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        addLog("✅ Deposit submitted! Waiting for bot verification...");
        addLog("The server will automatically start when both players are verified.");
        
        // NOTE: We do NOT set status to LIVE here!
        // The Bot will verify the tx_hash on-chain and set LIVE status.
        // The Realtime listener will update our UI when status changes.

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

      const isHost = matchData.player1_address?.toLowerCase() === address?.toLowerCase();
      const hasP2 = matchData.player2_address && matchData.player2_address !== '0x0000000000000000000000000000000000000000';
      
      // UNIFIED LOBBY & DEPOSIT VIEW
      if (['LOBBY', 'PENDING', 'DEPOSITING'].includes(matchData.status)) {
          // Ready Check: Use database flags for ready status
          const p1Ready = !!matchData.p1_ready;
          const p2Ready = !!matchData.p2_ready;
          const bothReady = p1Ready && p2Ready;
          const isDepositing = matchData.status === 'DEPOSITING';
          const myReady = isHost ? p1Ready : p2Ready;
          
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
                      {isDepositing && (
                          <DepositTimer startedAt={matchData.deposit_started_at} />
                      )}
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
                                                await fetch('/api/match/cancel', {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    credentials: 'include',
                                                    body: JSON.stringify({ matchId: matchData.id })
                                                });
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
                          // READY CHECK PHASE (before deposit)
                          <div className="w-full max-w-md flex flex-col gap-4">
                              {matchData.ready_started_at && !bothReady && (
                                  <div className="bg-yellow-900/20 border border-yellow-600/50 p-3 rounded-lg">
                                      <ReadyTimer startedAt={matchData.ready_started_at} />
                                  </div>
                              )}

                              {/* Opponent Identity Card - "Know Your Opponent" */}
                              <div className="bg-gray-800/80 border border-gray-600 p-4 rounded-xl">
                                  <p className="text-xs text-gray-500 mb-3 text-center uppercase tracking-wider">Your Opponent</p>
                                  <div className="flex items-center justify-center gap-4">
                                      <div className="w-14 h-14 bg-gradient-to-br from-red-500 to-orange-600 rounded-full flex items-center justify-center text-2xl shadow-lg">
                                          {isHost ? '🎮' : '👑'}
                                      </div>
                                      <div className="text-left">
                                          <p className="font-bold text-white">
                                              {isHost ? 'Player 2' : 'Player 1 (Host)'}
                                          </p>
                                          <p className="text-xs text-gray-400 font-mono">
                                              {isHost 
                                                  ? `${matchData.player2_address?.slice(0,6)}...${matchData.player2_address?.slice(-4)}`
                                                  : `${matchData.player1_address?.slice(0,6)}...${matchData.player1_address?.slice(-4)}`
                                              }
                                          </p>
                                          {((isHost && matchData.player2_steam) || (!isHost && matchData.player1_steam)) && (
                                              <p className="text-xs text-blue-400 mt-1">Steam Verified ✓</p>
                                          )}
                                      </div>
                                  </div>
                              </div>

                              {/* Ready Status Display */}
                              <div className="bg-gray-800/50 border border-gray-700 p-4 rounded-lg">
                                  <p className="text-xs text-gray-400 mb-2 text-center uppercase tracking-wider">Ready Check</p>
                                  <div className="flex justify-around">
                                      <div className={`text-center ${p1Ready ? 'text-green-400' : 'text-gray-500'}`}>
                                          <span className="text-2xl">{p1Ready ? '✅' : '⏳'}</span>
                                          <p className="text-xs mt-1 font-bold">{isHost ? 'YOU' : 'HOST'}</p>
                                      </div>
                                      <div className={`text-center ${p2Ready ? 'text-green-400' : 'text-gray-500'}`}>
                                          <span className="text-2xl">{p2Ready ? '✅' : '⏳'}</span>
                                          <p className="text-xs mt-1 font-bold">{!isHost ? 'YOU' : 'OPPONENT'}</p>
                                      </div>
                                  </div>
                              </div>

                              {/* Ready Button or Start Button */}
                              {!myReady ? (
                                  <button 
                                      onClick={handleReady}
                                      className="bg-green-600 hover:bg-green-500 text-white font-bold py-4 px-8 rounded-lg w-full shadow-lg shadow-green-900/20 text-lg animate-pulse"
                                  >
                                      I'M READY
                                  </button>
                              ) : !bothReady ? (
                                  <div className="text-center p-4 bg-gray-800/50 border border-gray-600 rounded-lg">
                                      <p className="text-green-400 font-bold mb-1">✅ You are READY</p>
                                      <p className="text-xs text-gray-400 animate-pulse">Waiting for opponent...</p>
                                  </div>
                              ) : (
                                  <div className="text-center p-4 bg-blue-900/30 border border-blue-500 rounded-lg animate-pulse">
                                      <p className="text-blue-400 font-bold text-lg">🚀 BOTH READY!</p>
                                      <p className="text-xs text-gray-400">Starting deposit phase...</p>
                                  </div>
                              )}
                              
                              {/* Leave Lobby Button */}
                              <button
                                  onClick={leaveLobby}
                                  className="text-xs text-gray-500 hover:text-red-400 underline transition-colors"
                              >
                                  {isHost ? '🚪 Cancel Match' : '🚪 Leave Lobby'}
                              </button>
                          </div>
                      ) : (
                          // DEPOSIT FORM
                           <div className="w-full max-w-md flex flex-col gap-4">
                               {/* Deposit Timer */}
                               <div className="bg-yellow-900/20 border border-yellow-600/50 p-3 rounded-lg">
                                   <DepositTimer startedAt={matchData.deposit_started_at} />
                               </div>

                               {/* Check if current user has already submitted deposit */}
                               {(isHost && matchData.p1_tx_hash) || (!isHost && matchData.p2_tx_hash) ? (
                                   <div className="text-center p-4 bg-green-900/20 border border-green-500/50 rounded-lg">
                                       <p className="text-green-400 font-bold mb-1">✅ DEPOSIT SUBMITTED</p>
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
                                           className="bg-green-500 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold py-4 px-6 rounded-xl w-full shadow-[0_0_15px_rgba(34,197,94,0.4)] transition-all animate-pulse"
                                       >
                                           {isProcessing ? "PROCESSING..." : "💰 DEPOSIT 5 USDC"}
                                       </button>
                                   </>
                               )}
                           </div>
                      )}

                      <button 
                          onClick={async () => {
                              if(!confirm("Cancel this lobby?")) return;
                              const res = await fetch('/api/match/cancel', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  credentials: 'include',
                                  body: JSON.stringify({ matchId: matchData.id })
                              });
                              const { error } = await res.json();
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

      // VIEW_CANCELLED (Tombstone)
      if (matchData.status === 'CANCELLED') {
          const isPlayer1 = matchData.player1_address?.toLowerCase() === address?.toLowerCase();
          const myDeposit = isPlayer1 ? matchData.p1_deposited : matchData.p2_deposited;
          const opponentDeposit = isPlayer1 ? matchData.p2_deposited : matchData.p1_deposited;
          
          let reason = "Match was cancelled.";
          if (myDeposit && !opponentDeposit) {
              reason = "⏰ Opponent failed to deposit in time.";
          } else if (!myDeposit && opponentDeposit) {
              reason = "⏰ You failed to deposit in time.";
          } else if (!myDeposit && !opponentDeposit) {
              reason = "Neither player deposited.";
          }

          return (
              <div className="bg-gray-800/80 p-8 rounded-xl border border-red-900 text-center w-full max-w-lg">
                  {/* Header */}
                  <div className="flex items-center justify-center gap-3 mb-6">
                      <div className="w-12 h-12 bg-red-900/50 rounded-full flex items-center justify-center">
                          <span className="text-2xl">❌</span>
                      </div>
                      <h2 className="text-3xl font-black text-red-400">MATCH CANCELLED</h2>
                  </div>

                  {/* Reason */}
                  <p className="text-gray-300 mb-6">{reason}</p>

                  {/* Match Details */}
                  <div className="bg-black/50 p-4 rounded-lg mb-6 text-left">
                      <div className="flex justify-between text-sm mb-2">
                          <span className="text-gray-500">Match ID</span>
                          <span className="font-mono text-gray-300">{matchData.contract_match_id}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                          <span className="text-gray-500">Status</span>
                          <span className="text-red-400">{matchData.payout_status || 'CANCELLED'}</span>
                      </div>
                  </div>

                  {/* Refund Info */}
                  {myDeposit && (
                      <div className="bg-green-900/30 border border-green-700 p-4 rounded-lg mb-6">
                          <p className="text-green-400 font-bold mb-2">✅ Refund Processed</p>
                          <p className="text-sm text-gray-300">Your 5.00 USDC has been returned to your wallet.</p>
                          {matchData.refund_tx_hash && (
                              <a 
                                  href={`https://sepolia.basescan.org/tx/${matchData.refund_tx_hash}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-blue-400 hover:text-blue-300 underline mt-2 inline-block"
                              >
                                  View Transaction ↗
                              </a>
                          )}
                      </div>
                  )}

                  {!myDeposit && (
                      <div className="bg-gray-700/30 border border-gray-600 p-4 rounded-lg mb-6">
                          <p className="text-gray-400">No funds were deducted from your wallet.</p>
                      </div>
                  )}

                  {/* Return to Lobby */}
                  <button
                      onClick={() => {
                          setMatchData(null);
                          window.history.pushState({}, '', window.location.pathname);
                      }}
                      className="bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 text-white font-bold py-3 px-8 rounded-lg w-full transition-all"
                  >
                      Return to Lobby
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
                        if(!confirm("⚠️ NUKE: This will cancel ALL your active matches and release servers. Are you sure?")) return;
                        
                        // 1. Cancel all active matches
                        const { error: matchError } = await supabase
                            .from('matches')
                            .update({ status: 'CANCELLED' })
                            .or(`player1_address.eq.${address},player2_address.eq.${address}`)
                            .in('status', ['LOBBY', 'PENDING', 'DEPOSITING', 'LIVE']);
                        
                        // 2. Release any servers that were assigned to my matches
                        const { error: serverError } = await supabase
                            .from('game_servers')
                            .update({ status: 'FREE', current_match_id: null })
                            .eq('status', 'BUSY');
                        
                        if (matchError || serverError) {
                            alert("Nuke failed: " + (matchError?.message || serverError?.message));
                        } else {
                            alert("💥 All active matches cancelled and servers released.");
                            setMatchData(null);
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
