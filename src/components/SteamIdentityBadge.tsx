'use client';

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';

interface SessionData {
  authenticated: boolean;
  steamId?: string;
  steamName?: string;
  steamAvatar?: string;
}

export default function SteamIdentityBadge() {
  const { address, isConnected } = useAccount();
  const [session, setSession] = useState<SessionData | null>(null);

  useEffect(() => {
    async function fetchSession() {
      if (!address) {
        setSession(null);
        return;
      }
      
      try {
        const res = await fetch(`/api/auth/sessions?wallet=${address}`);
        const data = await res.json();
        setSession(data);
      } catch (e) {
        console.error("Session fetch failed", e);
      }
    }

    if (isConnected && address) {
      fetchSession();
    } else {
      setSession(null);
    }
  }, [address, isConnected]);

  if (!isConnected || !session?.authenticated) {
    return null;
  }

  const handleLogout = async () => {
    await fetch(`/api/auth/sessions?wallet=${address}`, { method: 'DELETE' });
    window.location.reload();
  };

  const handleSwitch = () => {
    // Redirect to Steam login to get a new session
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/api/auth/steam/login?address=${address}&returnTo=${returnTo}`;
  };

  return (
    <div className="flex items-center gap-3 bg-gray-800/50 border border-gray-700/50 px-4 py-2 rounded-2xl backdrop-blur-md animate-in fade-in slide-in-from-right-4 duration-500">
      {session.steamAvatar && (
        <img 
          src={session.steamAvatar} 
          alt="Steam Avatar" 
          className="w-8 h-8 rounded-lg"
        />
      )}
      
      <div className="flex flex-col text-right">
        <span className="text-[10px] text-blue-400 font-bold uppercase tracking-tighter">Playing As</span>
        <span className="text-xs font-mono text-white max-w-[120px] truncate">
          {session.steamName || "Steam User"}
        </span>
      </div>
      
      <div className="flex gap-1">
        <button 
          onClick={handleSwitch}
          title="Switch Steam Account"
          className="w-7 h-7 rounded-lg bg-white/5 hover:bg-blue-500/20 flex items-center justify-center transition-all group"
        >
          <span className="text-xs group-hover:scale-110 transition-transform">🔄</span>
        </button>
        
        <button 
          onClick={handleLogout}
          title="Sign Out"
          className="w-7 h-7 rounded-lg bg-white/5 hover:bg-red-500/20 flex items-center justify-center transition-all group"
        >
          <span className="text-xs group-hover:scale-110 transition-transform">🚪</span>
        </button>
      </div>
    </div>
  );
}
