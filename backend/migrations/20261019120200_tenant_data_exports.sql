-- Tenant personal-data export requests (issue #1899).
-- One row per POST /api/v1/tenant/data-export. The archive lives in object
-- storage under storage_key and expires 7 days after it becomes ready; the
-- data-retention job deletes expired archives.

CREATE TABLE IF NOT EXISTS tenant_data_exports (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'expired')),
    storage_key TEXT,
    failure_reason TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one active (pending or processing) export per user.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_data_exports_one_active_per_user
    ON tenant_data_exports (user_id)
    WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS tenant_data_exports_user_requested_idx
    ON tenant_data_exports (user_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS tenant_data_exports_expiry_idx
    ON tenant_data_exports (status, expires_at);
