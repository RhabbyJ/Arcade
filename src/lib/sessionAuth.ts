import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * Derive wallet address from session token.
 * Reads from either:
 * 1. Authorization: Bearer <token> header
 * 2. session_token cookie
 * 
 * Prevents wallet spoofing by not trusting client-provided wallet.
 */
export async function getWalletFromSession(req: NextRequest): Promise<string | null> {
    // Try Authorization header first
    const auth = req.headers.get("authorization")?.trim() ?? "";
    let token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

    // Fall back to cookie
    if (!token) {
        token = req.cookies.get("session_token")?.value ?? null;
    }

    if (!token) return null;

    const { data: session, error } = await supabaseAdmin
        .from("sessions")
        .select("wallet_address, expires_at")
        .eq("session_token", token)
        .maybeSingle();

    if (error || !session) return null;

    // Check expiry
    if (new Date(session.expires_at).getTime() < Date.now()) {
        return null;
    }

    return session.wallet_address.toLowerCase();
}

/**
 * Get full session data including Steam info
 */
export async function getSessionData(req: NextRequest): Promise<{
    wallet: string;
    steamId: string;
    steamName: string | null;
    steamAvatar: string | null;
} | null> {
    const auth = req.headers.get("authorization")?.trim() ?? "";
    let token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

    if (!token) {
        token = req.cookies.get("session_token")?.value ?? null;
    }

    if (!token) return null;

    const { data: session, error } = await supabaseAdmin
        .from("sessions")
        .select("wallet_address, steam_id, steam_name, steam_avatar, expires_at")
        .eq("session_token", token)
        .maybeSingle();

    if (error || !session) return null;

    if (new Date(session.expires_at).getTime() < Date.now()) {
        return null;
    }

    return {
        wallet: session.wallet_address.toLowerCase(),
        steamId: session.steam_id,
        steamName: session.steam_name,
        steamAvatar: session.steam_avatar
    };
}
