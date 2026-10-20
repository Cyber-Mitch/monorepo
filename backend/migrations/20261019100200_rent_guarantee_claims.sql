-- Rent guarantee insurance lifecycle (#1908).
-- Extends rent_guarantee_policies (031) with binding/cancellation metadata and
-- adds rent_guarantee_claims.

ALTER TABLE rent_guarantee_policies
  ADD COLUMN IF NOT EXISTS provider_reference TEXT,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS rent_guarantee_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id UUID NOT NULL REFERENCES rent_guarantee_policies(id) ON DELETE RESTRICT,
    landlord_id TEXT NOT NULL,
    amount_ngn NUMERIC(20,2) NOT NULL CHECK (amount_ngn > 0),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted', 'approved', 'rejected', 'paid')),
    provider_reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rent_guarantee_claims_policy_id_idx ON rent_guarantee_claims (policy_id);
CREATE INDEX IF NOT EXISTS rent_guarantee_claims_landlord_id_idx ON rent_guarantee_claims (landlord_id);
