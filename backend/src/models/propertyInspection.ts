/**
 * Property inspection domain types (#1904), backed by the tables in
 * migrations/040_property_inspections.sql.
 *
 * Lifecycle (enforced by the store + routes):
 *   pending -> in_progress -> submitted -> approved | rejected
 * Checklist items and photos may only be written while `in_progress`.
 */

import {
  INSPECTION_CATEGORIES,
  type InspectionCategory,
  type InspectionResult,
} from '../services/inspectionTrustScore.js'

export type { InspectionCategory, InspectionResult }

export type PropertyInspectionStatus =
  | 'pending'
  | 'in_progress'
  | 'submitted'
  | 'approved'
  | 'rejected'

export interface PropertyInspection {
  id: string
  listingId: string
  /** The assigned inspector: the verified inspector who created the inspection. */
  inspectorId: string
  status: PropertyInspectionStatus
  scheduledAt?: Date
  submittedAt?: Date
  approvedAt?: Date
  inspectorNotes?: string
  rejectionReason?: string
  reviewedBy?: string
  reviewedAt?: Date
  createdAt: Date
  updatedAt: Date
}

export interface InspectionChecklistItem {
  id: string
  inspectionId: string
  category: InspectionCategory
  item: string
  result: InspectionResult
  notes?: string
  createdAt: Date
  updatedAt: Date
}

export interface InspectionPhoto {
  id: string
  inspectionId: string
  /** Storage object key returned by the presign endpoint. */
  url: string
  caption?: string
  takenAt: Date
  createdAt: Date
}

export interface CreatePropertyInspectionInput {
  listingId: string
  inspectorId: string
  scheduledAt: Date
}

export interface ChecklistItemInput {
  category: InspectionCategory
  item: string
  result: InspectionResult
  notes?: string
}

export interface AddInspectionPhotoInput {
  url: string
  caption?: string
  takenAt?: Date
}

export const MIN_INSPECTION_PHOTOS = 3

export interface SubmitPreconditions {
  ok: boolean
  missingCategories: InspectionCategory[]
  photoCount: number
}

/**
 * Submit requires at least one checklist item in every category and at least
 * MIN_INSPECTION_PHOTOS photos. Shared by both store implementations.
 */
export function evaluateSubmitPreconditions(
  items: ReadonlyArray<Pick<InspectionChecklistItem, 'category'>>,
  photoCount: number,
): SubmitPreconditions {
  const present = new Set(items.map((i) => i.category))
  const missingCategories = INSPECTION_CATEGORIES.filter((c) => !present.has(c))
  return {
    ok: missingCategories.length === 0 && photoCount >= MIN_INSPECTION_PHOTOS,
    missingCategories,
    photoCount,
  }
}

export type SubmitInspectionResult =
  | { ok: true; inspection: PropertyInspection }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_state'; status: PropertyInspectionStatus }
  | { ok: false; reason: 'preconditions'; preconditions: SubmitPreconditions }

export type ApproveInspectionResult =
  | { ok: true; inspection: PropertyInspection; trustScore: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_state'; status: PropertyInspectionStatus }
  | { ok: false; reason: 'listing_not_found' }

export type GuardedWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_state'; status: PropertyInspectionStatus }
