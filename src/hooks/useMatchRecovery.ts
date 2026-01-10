import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';

export function useMatchRecovery() {
    const { address, isConnected } = useAccount();
    const [recoveredMatch, setRecoveredMatch] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function checkActiveMatch() {
            if (!isConnected) {
                setLoading(false);
                setRecoveredMatch(null);
                return;
            }

            if (!address) {
                return;
            }

            console.log("[Recovery] Checking for active matches for:", address);

            try {
                // Use API route with credentials to include session cookie
                const res = await fetch('/api/match/active', {
                    credentials: 'include' // Include httpOnly session cookie
                });

                if (res.status === 401) {
                    console.log("[Recovery] Not authenticated (no session)");
                    setRecoveredMatch(null);
                    setLoading(false);
                    return;
                }

                const { match, error } = await res.json();

                if (error) {
                    console.error("[Recovery] Error:", error);
                } else if (match) {
                    console.log("[Recovery] Found Active Match:", match);
                    setRecoveredMatch(match);
                } else {
                    console.log("[Recovery] No active match found.");
                    setRecoveredMatch(null);
                }
            } catch (e) {
                console.error("[Recovery] Exception:", e);
            }

            setLoading(false);
        }

        setLoading(true);
        checkActiveMatch();
    }, [address, isConnected]);

    return { recoveredMatch, loading };
}
