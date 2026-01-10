import { createClient } from '@supabase/supabase-js';

// Server-side Supabase client with service role key
// Use this for all settlement operations (bypasses RLS)
export const supabaseAdmin = createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
