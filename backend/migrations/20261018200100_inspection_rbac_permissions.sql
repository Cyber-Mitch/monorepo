-- RBAC permissions for property inspections (#1904) and the minimal
-- inspector verification endpoint (subset of #1902).
-- Modelled on the seed in 035_admin_rbac.sql.
--   inspections:review -> list/view/approve/reject inspections
--   inspectors:verify  -> set inspector_profiles.verification_status
-- super_admin implicitly holds both; the operations role is granted both.

INSERT INTO permissions (resource, action) VALUES
('inspections', 'review'),
('inspectors', 'verify')
ON CONFLICT (resource, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'operations' AND (
    (p.resource = 'inspections' AND p.action = 'review') OR
    (p.resource = 'inspectors' AND p.action = 'verify')
)
ON CONFLICT DO NOTHING;
