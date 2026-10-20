import { z } from 'zod'
import {
  INSPECTION_CATEGORIES,
  INSPECTION_RESULTS,
} from '../services/inspectionTrustScore.js'

/**
 * Schemas for property inspections (#1904) and the minimal inspector
 * verification endpoint (subset of #1902).
 */

export const inspectionIdParamSchema = z.object({
  id: z.string().uuid('Inspection id must be a UUID'),
})

export const createInspectionSchema = z.object({
  listingId: z.string().uuid().describe('Listing (whistleblower_listings.listing_id) to inspect'),
  scheduledAt: z.coerce.date().describe('When the inspection is scheduled'),
})

export type CreateInspectionRequest = z.infer<typeof createInspectionSchema>

export const checklistItemSchema = z.object({
  category: z.enum(INSPECTION_CATEGORIES),
  item: z.string().trim().min(1).max(200),
  result: z.enum(INSPECTION_RESULTS),
  notes: z.string().max(2000).optional(),
})

export const upsertChecklistSchema = z.object({
  items: z.array(checklistItemSchema).min(1).max(200),
})

export type UpsertChecklistRequest = z.infer<typeof upsertChecklistSchema>

export const INSPECTION_PHOTO_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const

export const presignInspectionPhotoSchema = z.object({
  contentType: z.enum(INSPECTION_PHOTO_CONTENT_TYPES),
})

export const registerInspectionPhotoSchema = z.object({
  objectKey: z.string().min(1).max(500),
  caption: z.string().max(500).optional(),
  takenAt: z.coerce.date().optional(),
})

export const submitInspectionSchema = z.object({
  inspectorNotes: z.string().max(5000).optional(),
})

export const rejectInspectionSchema = z.object({
  reason: z.string().trim().min(1, 'Rejection reason is required').max(1000),
})

export const listInspectionsQuerySchema = z.object({
  status: z.enum(['pending', 'in_progress', 'submitted', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

export const listingIdParamSchema = z.object({
  id: z.string().uuid('Listing id must be a UUID'),
})

export const inspectorUserIdParamSchema = z.object({
  userId: z.string().min(1).max(200),
})

export const setInspectorVerificationSchema = z.object({
  status: z.enum(['pending', 'verified', 'suspended']),
})
