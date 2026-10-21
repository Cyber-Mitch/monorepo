-- RBAC permission for reading the audit log (issue #1940), replacing the shared
-- x-admin-secret check on GET /api/v1/admin/audit-logs and GET /api/admin/audit.
--   audit:view — search the audit log and verify its hash chain.
-- The compliance role does not exist yet, so it is created here. super_admin
-- implicitly holds audit:view.
INSERT INTO roles (name, description) VALUES
('compliance', 'Compliance reviewer with read access to the audit log')
ON CONFLICT (name) DO NOTHING;

INSERT INTO permissions (resource, action) VALUES
('audit', 'view')
ON CONFLICT (resource, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'compliance' AND p.resource = 'audit' AND p.action = 'view'
ON CONFLICT DO NOTHING;
