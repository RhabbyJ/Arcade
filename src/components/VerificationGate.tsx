'use client';

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { supabase } from '@/lib/supabase';
import SteamLinkButton from './SteamLinkButton';

export default function VerificationGate({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const [isLinked, setIsLinked] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function checkUser() {
      if (!address) {
          setIsLoading(false);
          return;
      }
      
      const { data } = await supabase
        .from('users')
        .select('steam_id')
        .eq('wallet_address', address)
        .maybeSingle();
      
      if (data?.steam_id) {
        setIsLinked(true);
      } else {
        setIsLinked(false);
      }
      setIsLoading(false);
    }

    if (isConnected && address) {
        setIsLoading(true);
        checkUser();
    } else {
        setIsLinked(false);
        setIsLoading(false);
    }
  }, [address, isConnected]);

  // 1. Wallet Not Connected? Let the main page handle it
  if (!isConnected) return <>{children}</>;

  // 2. Loading State
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500 mb-4"></div>
        <p className="text-gray-400 font-mono text-xs uppercase tracking-widest">Verifying Identity...</p>
      </div>
    );
  }

  // 3. Wallet Connected BUT No Steam Link? -> BLOCKING GATE
  if (!isLinked) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <div className="p-10 border border-white/10 rounded-3xl bg-gray-900/40 backdrop-blur-2xl max-w-md w-full shadow-2xl relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-600/5 to-purple-600/5 opacity-50"></div>
            
            <div className="w-20 h-20 bg-blue-500/10 rounded-2xl flex items-center justify-center mx-auto mb-8 border border-blue-500/20 shadow-inner relative z-10">
                <span className="text-4xl">🔐</span>
            </div>
            
            <h2 className="text-3xl font-black text-white mb-3 relative z-10 tracking-tight">Identity Required</h2>
            <p className="text-gray-400 mb-10 relative z-10 leading-relaxed text-sm">
                To prevent cheaters and ensure fair payouts, you must link your Steam account to wallet <span className="text-blue-400 font-mono">{address?.slice(0,6)}...{address?.slice(-4)}</span>.
            </p>
            
            <SteamLinkButton className="relative z-10" />
            
            <div className="mt-8 pt-6 border-t border-white/5 relative z-10">
                <p className="text-[10px] text-gray-600 uppercase tracking-tighter font-bold">
                    Official Valve OpenID 2.0 Secure Login
                </p>
            </div>
        </div>
      </div>
    );
  }

  // 4. Everything Good? Render the App
  return <>{children}</>;
}
