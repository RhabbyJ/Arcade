import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAccount } from 'wagmi';

export function useMatchRecovery() {
    const { address } = useAccount();
    const [recoveredMatch, setRecoveredMatch] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function checkActiveMatch() {
            if (!address) {
                setLoading(false);
                return;
            }

            console.log("Checking for active matches...");

            // Check if user is Player 1 OR Player 2 in an active match
            const { data, error } = await supabase
                .from('matches')
                .select('*')
                .or(`player1_address.eq.${address},player2_address.eq.${address}`)
                .in('status', ['LOBBY', 'DEPOSITING', 'VERIFYING_PAYMENT', 'PENDING', 'LIVE'])
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (data) {
                console.log("Recovered Active Match:", data);
                setRecoveredMatch(data);
            } else {
                console.log("No active match found.");
            }
            setLoading(false);
        }

        checkActiveMatch();
    }, [address]);

    return { recoveredMatch, loading };
}
