import React from 'react';

type MatchStatus = 'IDLE' | 'DEPOSITING' | 'PENDING' | 'LIVE' | 'COMPLETE' | 'DISPUTED' | 'PAID';

export function MatchStatusBadge({ status }: { status: MatchStatus }) {
  const getStyle = () => {
    switch (status) {
      case 'LIVE':
        return 'bg-red-500/20 text-red-400 border-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.5)]';
      case 'PENDING':
        return 'bg-yellow-500/20 text-yellow-400 border-yellow-500';
      case 'COMPLETE':
        return 'bg-green-500/20 text-green-400 border-green-500';
      case 'PAID':
          return 'bg-purple-500/20 text-purple-400 border-purple-500';
      case 'DEPOSITING':
        return 'bg-blue-500/20 text-blue-400 border-blue-500 animate-bounce';
      default:
        return 'bg-gray-500/20 text-gray-400 border-gray-500';
    }
  };

  return (
    <div className={`px-4 py-1 rounded-full border text-xs font-black tracking-widest uppercase ${getStyle()}`}>
      {status === 'LIVE' ? '● LIVE' : status}
    </div>
  );
}
