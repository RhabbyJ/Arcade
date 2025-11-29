'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useState } from 'react';
import { useAccount } from 'wagmi';
import { supabase } from '@/lib/supabase';

export default function Home() {
  const { address, isConnected } = useAccount();
  const [matchStatus, setMatchStatus] = useState<string>('IDLE'); // IDLE, PENDING, LIVE, COMPLETE
  const [matchId, setMatchId] = useState<string | null>(null);

  const createMatch = async () => {
    if (!address) return;
    
    // For MVP, we'll just insert a dummy match
    // In reality, this would trigger a deposit tx first
    const { data, error } = await supabase
      .from('matches')
      .insert([
        {
          player1_address: address,
          player2_address: '0x0000000000000000000000000000000000000000', // Waiting for opponent
          status: 'PENDING',
          payout_status: 'PENDING',
          contract_match_id: 123, // Mock ID
        },
      ])
      .select()
      .single();

    if (error) {
      console.error('Error creating match:', error);
      alert('Failed to create match');
    } else {
      setMatchId(data.id);
      setMatchStatus('PENDING');
    }
  };

  const launchGame = () => {
    // Replace with your actual server IP
    window.location.href = 'steam://connect/123.456.78.90:27015/password123';
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-8 font-[family-name:var(--font-geist-sans)]">
      <header className="absolute top-4 right-4">
        <ConnectButton />
      </header>

      <main className="flex flex-col gap-8 items-center text-center">
        <h1 className="text-5xl font-bold tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-600">
          DIGITAL ARCADE
        </h1>
        <p className="text-xl text-gray-400">1v1 CS2 Wagering. Winner Takes All.</p>

        {isConnected ? (
          <div className="flex flex-col gap-4 w-full max-w-md">
            {matchStatus === 'IDLE' && (
              <button
                onClick={createMatch}
                className="bg-green-500 hover:bg-green-600 text-black font-bold py-4 px-8 rounded-xl transition-all transform hover:scale-105"
              >
                DEPOSIT 5 USDC
              </button>
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
