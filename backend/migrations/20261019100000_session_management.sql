-- Active session management (#1907).
--   sessions.family links an access-token session to its refresh-token family so
--   revoking a session can also invalidate the matching refresh tokens.
--   users:manage permission gates admin force-logout (super_admin holds it implicitly).

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS family TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_family ON sessions(family) WHERE family IS NOT NULL;

INSERT INTO permissions (resource, action) VALUES
('users', 'manage')
ON CONFLICT (resource, action) DO NOTHING;
