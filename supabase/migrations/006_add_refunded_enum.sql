-- The error "22P02 - invalid input value for enum payout_status: REFUNDED"
-- confirms that 'REFUNDED' is missing from the enum definition.

-- Run this in Supabase SQL Editor:
ALTER TYPE payout_status ADD VALUE 'REFUNDED';
