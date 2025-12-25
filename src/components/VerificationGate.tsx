'use client';

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { supabase } from '@/lib/supabase';
import SteamLinkButton from './SteamLinkButton';

export default function VerificationGate({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const [dbSteamId, setDbSteamId] = useState<string | null>(null);
  const [sessionSteamId, setSessionSteamId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function checkIdentity() {
      if (!address) {
          setIsLoading(false);
          return;
      }
      
      // 1. Get DB Link
      const { data: dbData } = await supabase
        .from('users')
        .select('steam_id')
        .eq('wallet_address', address)
        .maybeSingle();
      
      const linkedSteamId = dbData?.steam_id || null;
      setDbSteamId(linkedSteamId);

      // 2. Get Browser Session
      try {
          const res = await fetch('/api/auth/steam/session');
          const session = await res.json();
          if (session.authenticated) {
              setSessionSteamId(session.steamId);
          }
      } catch (e) {
          console.error("Session check failed", e);
      }
      
      setIsLoading(false);
    }

    if (isConnected && address) {
        setIsLoading(true);
        checkIdentity();
    } else {
        setDbSteamId(null);
        setSessionSteamId(null);
        setIsLoading(false);
    }
  }, [address, isConnected]);

  // 1. Wallet Not Connected? Pass through
  if (!isConnected) return <>{children}</>;

  // 2. Loading...
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500 mb-4"></div>
        <p className="text-gray-400 font-mono text-xs uppercase tracking-widest">Verifying Identity...</p>
      </div>
    );
  }

  // 3. CASE A: No Link in DB -> PROMPT LINK
  if (!dbSteamId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <div className="p-10 border border-white/10 rounded-3xl bg-gray-900/40 backdrop-blur-2xl max-w-md w-full shadow-2xl relative overflow-hidden group">
            <h2 className="text-3xl font-black text-white mb-3 relative z-10 tracking-tight">Identity Required</h2>
            <p className="text-gray-400 mb-10 relative z-10 leading-relaxed text-sm">
                Link your Steam account to verify wallet <span className="text-blue-400 font-mono">{address?.slice(0,6)}...</span>
            </p>
            <SteamLinkButton className="relative z-10" />
        </div>
      </div>
    );
  }

  // 4. CASE B: Linked in DB, BUT Session Mismatch -> WARNING & OVERWRITE OPTION
  if (sessionSteamId && sessionSteamId !== dbSteamId) {
      return (
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="p-8 border border-yellow-500/50 rounded-3xl bg-yellow-900/10 backdrop-blur-2xl max-w-lg w-full shadow-2xl">
                <div className="text-6xl mb-4">⚠️</div>
                <h2 className="text-2xl font-bold text-white mb-2">Identity Mismatch</h2>
                <p className="text-gray-400 mb-6 text-sm">
                    This wallet is linked to Steam ID <span className="font-mono text-white">{dbSteamId}</span>,<br/>
                    but you are logged into Steam ID <span className="font-mono text-yellow-400">{sessionSteamId}</span>.
                </p>
                
                <div className="flex flex-col gap-3">
                    <button 
                        onClick={() => window.location.href = `/api/auth/steam/login?address=${address}`} 
                        className="bg-red-600 hover:bg-red-500 text-white font-bold py-3 px-6 rounded-xl transition-all"
                    >
                        RELINK to Current Steam Account
                    </button>
                    <p className="text-xs text-gray-500">
                        (This will overwrite the old link with your current Steam login)
                    </p>
                    
                    <div className="my-2 border-t border-white/10"></div>

                    <a href="https://steamcommunity.com/login/logout/" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline text-sm">
                        No, let me switch Steam accounts
                    </a>
                </div>
            </div>
          </div>
      );
  }

  // 5. CASE C: Linked in DB, No Session -> FORCE LOGIN (Verify Session)
  if (!sessionSteamId) {
      return (
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
              <div className="p-10 border border-blue-500/30 rounded-3xl bg-gray-900/40 backdrop-blur-2xl max-w-md w-full shadow-2xl">
                <h2 className="text-2xl font-bold text-white mb-4">Verify Session</h2>
                <p className="text-gray-400 mb-8 text-sm">
                    Please verify your Steam session to continue playing.
                </p>
                <SteamLinkButton />
              </div>
          </div>
      );
  }

  // 6. ALL GOOD (DB matches Session)
  return <>{children}</>;
}
