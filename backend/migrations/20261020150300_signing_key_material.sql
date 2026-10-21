-- Encrypted key material for rotated signing keys (issue #1941).
-- Before this table, rotated secrets lived only in process memory, so a restart
-- after a rotation left admin signing with no key for the active key id.
--
-- ciphertext is the envelope produced by the EncryptionService (the same envelope
-- format as custodial wallet keys), and key_version names the encryption key that
-- sealed it. A plaintext secret is never written here.
--
-- Destroying a key sets ciphertext to '' and stamps retired_at. The row stays as
-- a tombstone for the audit trail and holds no secret material.
CREATE TABLE IF NOT EXISTS signing_key_material (
    key_id      TEXT        NOT NULL,
    key_type    TEXT        NOT NULL CHECK (key_type IN ('admin', 'custodial_wallet')),
    ciphertext  TEXT        NOT NULL,
    key_version TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    retired_at  TIMESTAMPTZ,
    PRIMARY KEY (key_type, key_id)
);
