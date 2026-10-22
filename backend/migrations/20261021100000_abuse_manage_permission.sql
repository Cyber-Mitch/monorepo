-- Add abuse management permissions for #1976

INSERT INTO permissions (resource, action) VALUES
('abuse', 'manage')
ON CONFLICT (resource, action) DO NOTHING;

-- Grant abuse:manage to super_admin (implicit, no row needed)
-- Grant abuse:manage to operations role
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'operations' AND p.resource = 'abuse' AND p.action = 'manage'
ON CONFLICT DO NOTHING;
