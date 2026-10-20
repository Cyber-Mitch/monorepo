-- RBAC permissions for the admin quota routes (issue #1936), replacing the
-- placeholder isAdmin() check in adminQuota.ts.
--   quota:view   — usage, overrides and stats
--   quota:manage — create/remove overrides and reset quotas
-- Modelled on the seed in 035_admin_rbac.sql. super_admin implicitly holds everything.
-- Quota overrides decide who may exceed rate limits, so manage goes to operations only;
-- view also goes to support, who need to see a user's current usage.
INSERT INTO permissions (resource, action) VALUES
('quota', 'view'),
('quota', 'manage')
ON CONFLICT (resource, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'operations' AND p.resource = 'quota'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'support' AND p.resource = 'quota' AND p.action = 'view'
ON CONFLICT DO NOTHING;
