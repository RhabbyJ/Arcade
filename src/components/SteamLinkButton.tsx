'use client';

import { useAccount } from 'wagmi';

interface SteamLinkButtonProps {
  className?: string;
}

export default function SteamLinkButton({ className }: SteamLinkButtonProps) {
  const { address } = useAccount();

  const handleSteamLink = () => {
    if (!address) return alert("Connect Wallet First!");
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/api/auth/steam/login?address=${address}&returnTo=${returnTo}`;
  };

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      <button 
        onClick={handleSteamLink}
        className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 px-8 rounded-2xl transition-all shadow-[0_0_20px_rgba(37,99,235,0.4)] flex items-center justify-center gap-3 w-full group overflow-hidden relative"
      >
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700"></div>
        <span className="text-xl">🎮</span> Link Steam Account
      </button>
      
      <p className="text-[10px] text-gray-500 text-center uppercase tracking-widest font-bold">
        Logged into the wrong Steam? <a href="https://steamcommunity.com/login/logout/" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">Switch Account</a>
      </p>
    </div>
  );
}
