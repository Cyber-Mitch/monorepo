-- RBAC permissions for the admin routes moved off x-admin-secret (#1937, #1938, #1939).
-- Modelled on 035_admin_rbac.sql. super_admin implicitly holds everything.
-- Reconciliation and settlement go to finance; fraud, jobs and whistleblower_applications to
-- operations. The on-chain resources (chain_admin, contract_access, circuit_breaker, timelock)
-- are granted to no role: give them explicitly to the people who should hold them.
INSERT INTO permissions (resource, action) VALUES
('reconciliation', 'view'), ('reconciliation', 'manage'),
('settlement', 'view'), ('settlement', 'manage'),
('fraud', 'view'), ('fraud', 'manage'),
('whistleblower_applications', 'view'), ('whistleblower_applications', 'manage'),
('jobs', 'view'), ('jobs', 'manage'),
('chain_admin', 'view'), ('chain_admin', 'execute'),
('contract_access', 'view'), ('contract_access', 'execute'),
('circuit_breaker', 'view'), ('circuit_breaker', 'execute'),
('timelock', 'view'), ('timelock', 'execute')
ON CONFLICT (resource, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'finance' AND p.resource IN ('reconciliation', 'settlement')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'operations' AND p.resource IN ('fraud', 'jobs', 'whistleblower_applications')
ON CONFLICT DO NOTHING;
