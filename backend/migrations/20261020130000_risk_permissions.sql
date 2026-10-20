-- RBAC permissions for the admin risk routes (#1933): risk:view for reads, risk:manage for
-- freeze and unfreeze. Modelled on 035_admin_rbac.sql. super_admin implicitly holds everything.
-- Freezing an account stops its payments, so risk:manage goes to finance and operations;
-- risk:view also to support, who need to see why an account is frozen.
INSERT INTO permissions (resource, action) VALUES
('risk', 'view'),
('risk', 'manage')
ON CONFLICT (resource, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name IN ('finance', 'operations') AND p.resource = 'risk'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'support' AND p.resource = 'risk' AND p.action = 'view'
ON CONFLICT DO NOTHING;
