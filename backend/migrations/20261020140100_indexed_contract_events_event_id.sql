-- Key indexed contract events by the Soroban event id (#1951).
-- The old unique index on (transaction_hash, ledger_sequence) collapses every event
-- emitted by one transaction into a single row. Soroban gives each event a unique id
-- per contract, so replayed RPC pages are ignored by (contract_id, event_id).
ALTER TABLE indexed_contract_events ADD COLUMN IF NOT EXISTS event_id TEXT;

DROP INDEX IF EXISTS indexed_contract_events_unique_event;

CREATE UNIQUE INDEX IF NOT EXISTS indexed_contract_events_contract_event_id_key
    ON indexed_contract_events(contract_id, event_id);
