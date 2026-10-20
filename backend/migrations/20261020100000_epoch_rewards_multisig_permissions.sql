-- RBAC permissions for the epoch rewards and multisig admin endpoints (#1965, #1972).
-- Modelled on the seed in 035_admin_rbac.sql. super_admin implicitly holds every
-- permission.
--
--   rewards:manage  POST /api/v1/admin/epoch-rewards/fund and /seal. Funding moves
--                   tokens from the admin account into the rewards contract, so it
--                   goes to the finance role, as vesting:manage does.
--   multisig:sign   Everything under /api/v1/admin/multisig. Approving a proposal
--                   authorises a privileged on-chain action, so it is NOT granted to
--                   any role by default: grant it explicitly to the people who hold
--                   a signer wallet.

INSERT INTO permissions (resource, action) VALUES
('rewards', 'manage'),
('multisig', 'sign')
ON CONFLICT (resource, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'finance' AND (
    (p.resource = 'rewards' AND p.action = 'manage')
)
ON CONFLICT DO NOTHING;
