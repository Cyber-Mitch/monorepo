-- Persistent NGN withdrawals (#1944). Until now they lived in a process-local array, so a restart
-- lost every pending withdrawal and each instance saw a different set.
--
-- ngn_wallets and ngn_ledger_entries are created here only if they do not exist yet: the Postgres
-- wallet store already queries them, but no earlier migration defines them. Withdrawal status
-- changes and their ledger entries are written in one transaction (see ngnWithdrawalStore.ts).

CREATE TABLE IF NOT EXISTS ngn_wallets (
    wallet_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL UNIQUE,
    currency TEXT NOT NULL DEFAULT 'NGN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ngn_ledger_entries (
    entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL,
    type TEXT NOT NULL,
    amount_ngn BIGINT NOT NULL,
    reference_type TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ngn_ledger_entries_wallet_idx ON ngn_ledger_entries (wallet_id, created_at);
CREATE INDEX IF NOT EXISTS ngn_ledger_entries_reference_idx ON ngn_ledger_entries (reference_type, reference_id);

CREATE TABLE IF NOT EXISTS ngn_withdrawals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    wallet_id UUID NOT NULL,
    amount_ngn BIGINT NOT NULL CHECK (amount_ngn > 0),
    bank_account_number TEXT NOT NULL,
    bank_account_name TEXT NOT NULL,
    bank_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'processing', 'confirmed', 'failed', 'rejected')),
    reference TEXT NOT NULL UNIQUE,
    failure_reason TEXT,
    approved_by TEXT,
    approved_at TIMESTAMPTZ,
    payout_started_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ngn_withdrawals_user_idx ON ngn_withdrawals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ngn_withdrawals_status_idx ON ngn_withdrawals (status, created_at);
