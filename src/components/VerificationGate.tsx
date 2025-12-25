'use client';

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import SteamLinkButton from './SteamLinkButton';

interface SessionData {
  authenticated: boolean;
  steamId?: string;
  steamName?: string;
  steamAvatar?: string;
}

export default function VerificationGate({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const [session, setSession] = useState<SessionData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function checkSession() {
      if (!address) {
        setSession(null);
        setIsLoading(false);
        return;
      }
      
      try {
        // Check for active session for THIS wallet
        const res = await fetch(`/api/auth/sessions?wallet=${address}`);
        const data = await res.json();
        setSession(data);
      } catch (e) {
        console.error("Session check failed", e);
        setSession({ authenticated: false });
      }
      
      setIsLoading(false);
    }

    if (isConnected && address) {
      setIsLoading(true);
      checkSession();
    } else {
      setSession(null);
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
        <p className="text-gray-400 font-mono text-xs uppercase tracking-widest">Checking Session...</p>
      </div>
    );
  }

  // 3. No Session? Prompt Login
  if (!session?.authenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <div className="p-10 border border-white/10 rounded-3xl bg-gray-900/40 backdrop-blur-2xl max-w-md w-full shadow-2xl relative overflow-hidden">
            <div className="w-20 h-20 bg-blue-500/10 rounded-2xl flex items-center justify-center mx-auto mb-8 border border-blue-500/20">
                <span className="text-4xl">🔐</span>
            </div>
            
            <h2 className="text-3xl font-black text-white mb-3 tracking-tight">Sign in with Steam</h2>
            <p className="text-gray-400 mb-10 leading-relaxed text-sm">
                Connect your Steam account to verify your identity for wallet <span className="text-blue-400 font-mono">{address?.slice(0,6)}...{address?.slice(-4)}</span>
            </p>
            
            <SteamLinkButton />
            
            <div className="mt-8 pt-6 border-t border-white/5">
                <p className="text-[10px] text-gray-600 uppercase tracking-tighter font-bold">
                    Session expires in 24 hours • You can switch accounts anytime
                </p>
            </div>
        </div>
      </div>
    );
  }

  // 4. Authenticated - Render children
  return <>{children}</>;
}
