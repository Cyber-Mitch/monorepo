-- RBAC permission for changing the underwriting rule engine (issue #1934):
--   GET  /api/v1/admin/underwriting/*          requires underwriting:view (already seeded)
--   PUT  /api/v1/admin/underwriting/config     requires underwriting:manage
--   POST /api/v1/admin/underwriting/evaluate/* requires underwriting:manage
-- Modelled on the seed in 035_admin_rbac.sql. underwriting:manage is deliberately
-- granted to no role: super_admin implicitly holds it, and anyone else must be
-- given it explicitly, because loosening the rules approves financing.
INSERT INTO permissions (resource, action) VALUES
('underwriting', 'manage')
ON CONFLICT (resource, action) DO NOTHING;
