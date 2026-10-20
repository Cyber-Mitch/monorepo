-- Issue #1900: RBAC permission for the admin erasure review endpoints
-- (GET /api/v1/admin/erasure, POST /api/v1/admin/erasure/:id/confirm).
-- Modelled on the seed in 035_admin_rbac.sql. super_admin implicitly holds
-- every permission; erasure:manage is additionally granted to the
-- operations role (platform/data operations). Confirming an erasure is
-- irreversible, so it is deliberately NOT granted to support or finance.

INSERT INTO permissions (resource, action) VALUES
('erasure', 'manage')
ON CONFLICT (resource, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'operations' AND (
    (p.resource = 'erasure' AND p.action = 'manage')
)
ON CONFLICT DO NOTHING;
