-- Issue #1900: enforce at most one pending erasure request per user.
-- ErasureService.requestErasure checks for an existing pending row before
-- inserting; this partial unique index closes the check-then-insert race so
-- concurrent POST /api/v1/user/erasure calls cannot create duplicates.

-- Collapse any pre-existing duplicates (keep the most recent pending request).
UPDATE erasure_requests er
SET status = 'cancelled', updated_at = NOW()
WHERE er.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM erasure_requests newer
    WHERE newer.user_id = er.user_id
      AND newer.status = 'pending'
      AND (newer.requested_at, newer.id) > (er.requested_at, er.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS erasure_requests_one_pending_per_user_uidx
  ON erasure_requests (user_id)
  WHERE status = 'pending';
