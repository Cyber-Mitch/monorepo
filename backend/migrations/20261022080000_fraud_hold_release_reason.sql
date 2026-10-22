-- Add release_reason column to fraud_account_holds
-- Allows reviewers to record why a hold was released (#1988)

ALTER TABLE fraud_account_holds
  ADD COLUMN IF NOT EXISTS release_reason TEXT;
