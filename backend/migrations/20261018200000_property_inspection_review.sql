-- Property inspection review support (#1904)
--
-- 040_property_inspections.sql created property_inspections without any
-- review metadata; admin approve/reject needs to record who reviewed, when,
-- and (for rejections) why.
ALTER TABLE property_inspections
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
    ADD COLUMN IF NOT EXISTS reviewed_by TEXT,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- PUT /inspections/:id/checklist upserts items keyed by (category, item).
CREATE UNIQUE INDEX IF NOT EXISTS inspection_checklist_items_inspection_category_item_uidx
    ON inspection_checklist_items (inspection_id, category, item);

-- Public summary looks up the latest approved inspection per listing.
CREATE INDEX IF NOT EXISTS property_inspections_listing_approved_idx
    ON property_inspections (listing_id, approved_at DESC)
    WHERE status = 'approved';
