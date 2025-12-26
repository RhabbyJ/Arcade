import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAccount } from 'wagmi';

export function useMatchRecovery() {
    const { address, isConnected } = useAccount();
    const [recoveredMatch, setRecoveredMatch] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function checkActiveMatch() {
            // Wait for wallet connection to be determined
            // isConnected = false means "not connected"
            // isConnected = undefined means "still checking"

            if (!isConnected) {
                // If definitely not connected, stop loading
                // They'll need to connect wallet first anyway
                setLoading(false);
                setRecoveredMatch(null);
                return;
            }

            if (!address) {
                // Connected but address not yet resolved - keep waiting
                return;
            }

            console.log("[Recovery] Checking for active matches for:", address);

            try {
                const { data, error } = await supabase
                    .from('matches')
                    .select('*')
                    .or(`player1_address.eq.${address},player2_address.eq.${address}`)
                    .in('status', ['LOBBY', 'DEPOSITING', 'VERIFYING_PAYMENT', 'PENDING', 'LIVE'])
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (error) {
                    console.error("[Recovery] Error:", error);
                } else if (data) {
                    console.log("[Recovery] Found Active Match:", data);
                    setRecoveredMatch(data);
                } else {
                    console.log("[Recovery] No active match found.");
                    setRecoveredMatch(null);
                }
            } catch (e) {
                console.error("[Recovery] Exception:", e);
            }

            setLoading(false);
        }

        // Reset loading when address changes
        setLoading(true);
        checkActiveMatch();
    }, [address, isConnected]);

    return { recoveredMatch, loading };
}
