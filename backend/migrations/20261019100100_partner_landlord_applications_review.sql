-- Partner landlord application review workflow (#1909).
-- Widens status beyond 'pending' and records who reviewed an application.
-- landlords:manage gates the admin list/update endpoints; super_admin holds it
-- implicitly and the operations role is granted it.

ALTER TABLE partner_landlord_applications
  DROP CONSTRAINT IF EXISTS partner_landlord_applications_status_check;

ALTER TABLE partner_landlord_applications
  ADD CONSTRAINT partner_landlord_applications_status_check
  CHECK (status IN ('pending', 'contacted', 'approved', 'rejected'));

ALTER TABLE partner_landlord_applications
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE INDEX IF NOT EXISTS idx_partner_landlord_applications_email_created_at
  ON partner_landlord_applications (LOWER(email), created_at DESC);

INSERT INTO permissions (resource, action) VALUES
('landlords', 'manage')
ON CONFLICT (resource, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'operations' AND p.resource = 'landlords' AND p.action = 'manage'
ON CONFLICT DO NOTHING;
