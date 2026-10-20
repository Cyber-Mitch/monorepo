-- RBAC permission for inspector onboarding review (issue #1902):
--   GET  /api/v1/admin/inspectors
--   POST /api/v1/admin/inspectors/:userId/verify
--   POST /api/v1/admin/inspectors/:userId/suspend
-- Modelled on the seed in 035_admin_rbac.sql. super_admin implicitly holds
-- every permission; inspectors:manage is additionally granted to the
-- operations role. The older inspectors:verify permission is left in place
-- for the existing PATCH /:userId/verification endpoint.

INSERT INTO permissions (resource, action) VALUES
('inspectors', 'manage')
ON CONFLICT (resource, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'operations' AND (
    (p.resource = 'inspectors' AND p.action = 'manage')
)
ON CONFLICT DO NOTHING;
