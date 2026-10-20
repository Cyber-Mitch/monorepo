-- RBAC permission for the admin credit score lookup (issue #1901):
--   GET /api/v1/admin/credit-score/:userId requires underwriting:view.
-- Modelled on the seed in 035_admin_rbac.sql. super_admin implicitly holds
-- every permission; underwriting:view is additionally granted to the
-- operations role, which already reviews KYC and disputes.

INSERT INTO permissions (resource, action) VALUES
('underwriting', 'view')
ON CONFLICT (resource, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'operations' AND (
    (p.resource = 'underwriting' AND p.action = 'view')
)
ON CONFLICT DO NOTHING;
