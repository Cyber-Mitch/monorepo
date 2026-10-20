/**
 * Property Inspection Routes (#1904)
 *
 * Inspector routes (mounted at /api/v1/inspections):
 *   POST   /                      create (verified inspectors only)
 *   PATCH  /:id/start             pending -> in_progress
 *   PUT    /:id/checklist         upsert checklist items (in_progress only)
 *   POST   /:id/photos/presign    presigned upload URL for a photo
 *   POST   /:id/photos            register an uploaded photo (in_progress only)
 *   POST   /:id/submit            in_progress -> submitted
 *
 * "Assigned" inspector = the verified inspector who created the inspection
 * (property_inspections.inspector_id). Every /:id route requires the caller to
 * be that inspector AND still verified.
 *
 * Public route (mounted at /api/v1/listings):
 *   GET    /:id/inspection        latest approved inspection summary (no PII)
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requireVerifiedInspector } from '../middleware/requireVerifiedInspector.js'
import { validate } from '../middleware/validate.js'
import { propertyInspectionStore } from '../models/propertyInspectionStore.js'
import { listingStore } from '../models/listingStore.js'
import { ListingStatus } from '../models/listing.js'
import type {
  GuardedWriteResult,
  PropertyInspection,
  PropertyInspectionStatus,
} from '../models/propertyInspection.js'
import {
  createInspectionSchema,
  inspectionIdParamSchema,
  listingIdParamSchema,
  presignInspectionPhotoSchema,
  registerInspectionPhotoSchema,
  submitInspectionSchema,
  upsertChecklistSchema,
  type CreateInspectionRequest,
  type UpsertChecklistRequest,
} from '../schemas/propertyInspection.js'
import {
  INSPECTION_CATEGORIES,
  computeInspectionTrustScore,
} from '../services/inspectionTrustScore.js'
import {
  buildInspectionReportObjectKey,
  generatePresignedUpload,
} from '../services/storageService.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'

export function invalidTransition(
  current: PropertyInspectionStatus,
  action: string,
): AppError {
  return new AppError(
    ErrorCode.INVALID_STATE_TRANSITION,
    409,
    `Cannot ${action} an inspection with status '${current}'`,
    { status: current },
  )
}

/** Converts a non-ok guarded store result into the matching AppError. */
export function unwrapGuarded<T>(result: GuardedWriteResult<T>, action: string): T {
  if (result.ok) return result.value
  if (result.reason === 'not_found') {
    throw new AppError(ErrorCode.NOT_FOUND, 404, 'Inspection not found')
  }
  throw invalidTransition(result.status, action)
}

/** Loads the inspection and ensures the caller is its assigned inspector. */
async function loadAssignedInspection(req: Request): Promise<PropertyInspection> {
  const userId = (req as AuthenticatedRequest).user!.id
  const inspection = await propertyInspectionStore.findById(req.params.id)
  if (!inspection) {
    throw new AppError(ErrorCode.NOT_FOUND, 404, 'Inspection not found')
  }
  if (inspection.inspectorId !== userId) {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'Access denied')
  }
  return inspection
}

function photoKeyPrefix(inspectionId: string): string {
  // Reuses the existing inspection object-key layout from storageService.
  return `inspection-reports/${inspectionId}/`
}

const router = Router()

router.post(
  '/',
  authenticateToken,
  requireVerifiedInspector,
  validate(createInspectionSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inspectorId = (req as AuthenticatedRequest).user!.id
      const { listingId, scheduledAt } = req.body as CreateInspectionRequest

      const listing = await listingStore.getById(listingId)
      if (!listing) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Listing not found')
      }

      const inspection = await propertyInspectionStore.create({
        listingId,
        inspectorId,
        scheduledAt,
      })

      auditLog('INSPECTION_CREATED', extractAuditContext(req, 'user'), {
        inspectionId: inspection.id,
        listingId,
      })

      res.status(201).json({ success: true, data: inspection })
    } catch (error) {
      next(error)
    }
  },
)

router.patch(
  '/:id/start',
  authenticateToken,
  requireVerifiedInspector,
  validate(inspectionIdParamSchema, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await loadAssignedInspection(req)
      const inspection = unwrapGuarded(
        await propertyInspectionStore.transition(req.params.id, 'pending', 'in_progress'),
        'start',
      )

      auditLog('INSPECTION_STARTED', extractAuditContext(req, 'user'), {
        inspectionId: inspection.id,
      })

      res.json({ success: true, data: inspection })
    } catch (error) {
      next(error)
    }
  },
)

router.put(
  '/:id/checklist',
  authenticateToken,
  requireVerifiedInspector,
  validate(inspectionIdParamSchema, 'params'),
  validate(upsertChecklistSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await loadAssignedInspection(req)
      const { items } = req.body as UpsertChecklistRequest
      const saved = unwrapGuarded(
        await propertyInspectionStore.upsertChecklistItems(req.params.id, items),
        'edit the checklist of',
      )
      res.json({ success: true, data: { items: saved } })
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/:id/photos/presign',
  authenticateToken,
  requireVerifiedInspector,
  validate(inspectionIdParamSchema, 'params'),
  validate(presignInspectionPhotoSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inspection = await loadAssignedInspection(req)
      if (inspection.status !== 'in_progress') {
        throw invalidTransition(inspection.status, 'add photos to')
      }
      const { contentType } = req.body as { contentType: string }
      const objectKey = buildInspectionReportObjectKey(inspection.id, contentType)
      const { uploadUrl, expiresAt } = await generatePresignedUpload(objectKey, contentType)
      res.json({ success: true, data: { uploadUrl, objectKey, expiresAt } })
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/:id/photos',
  authenticateToken,
  requireVerifiedInspector,
  validate(inspectionIdParamSchema, 'params'),
  validate(registerInspectionPhotoSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inspection = await loadAssignedInspection(req)
      const { objectKey, caption, takenAt } = req.body as {
        objectKey: string
        caption?: string
        takenAt?: Date
      }
      if (!objectKey.startsWith(photoKeyPrefix(inspection.id)) || objectKey.includes('..')) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          'objectKey must be a key issued by the photo presign endpoint for this inspection',
        )
      }
      const photo = unwrapGuarded(
        await propertyInspectionStore.addPhoto(inspection.id, {
          url: objectKey,
          caption,
          takenAt,
        }),
        'add photos to',
      )
      res.status(201).json({ success: true, data: photo })
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/:id/submit',
  authenticateToken,
  requireVerifiedInspector,
  validate(inspectionIdParamSchema, 'params'),
  validate(submitInspectionSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await loadAssignedInspection(req)
      const { inspectorNotes } = req.body as { inspectorNotes?: string }
      const result = await propertyInspectionStore.submit(req.params.id, inspectorNotes)

      if (!result.ok) {
        if (result.reason === 'not_found') {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Inspection not found')
        }
        if (result.reason === 'invalid_state') {
          throw invalidTransition(result.status, 'submit')
        }
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          'Inspection is incomplete: at least one checklist item per category and at least 3 photos are required',
          {
            missingCategories: result.preconditions.missingCategories,
            photoCount: result.preconditions.photoCount,
          },
        )
      }

      auditLog('INSPECTION_SUBMITTED', extractAuditContext(req, 'user'), {
        inspectionId: result.inspection.id,
      })

      res.json({ success: true, data: result.inspection })
    } catch (error) {
      next(error)
    }
  },
)

export function createPropertyInspectionsRouter(): Router {
  return router
}

const listingRouter = Router()

/**
 * GET /api/v1/listings/:id/inspection
 * Public summary of the latest approved inspection for a publicly visible
 * (approved) listing. Deliberately omits inspector identity, reviewer identity
 * and free-text notes.
 */
listingRouter.get(
  '/:id/inspection',
  validate(listingIdParamSchema, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const listing = await listingStore.getById(req.params.id)
      if (!listing || listing.status !== ListingStatus.APPROVED) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      const inspection = await propertyInspectionStore.findLatestApprovedForListing(
        listing.listingId,
      )
      if (!inspection) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          404,
          'No approved inspection for this listing',
        )
      }

      const [items, photos] = await Promise.all([
        propertyInspectionStore.getChecklistItems(inspection.id),
        propertyInspectionStore.getPhotos(inspection.id),
      ])

      const categories = INSPECTION_CATEGORIES.map((category) => {
        const inCategory = items.filter((i) => i.category === category)
        return {
          category,
          pass: inCategory.filter((i) => i.result === 'pass').length,
          fail: inCategory.filter((i) => i.result === 'fail').length,
          na: inCategory.filter((i) => i.result === 'na').length,
        }
      })

      res.json({
        success: true,
        data: {
          listingId: listing.listingId,
          inspectionId: inspection.id,
          submittedAt: inspection.submittedAt,
          approvedAt: inspection.approvedAt,
          trustScore: listing.trustScore ?? computeInspectionTrustScore(items),
          hasVerifiedInspection: listing.hasVerifiedInspection ?? true,
          categories,
          items: items.map(({ category, item, result }) => ({ category, item, result })),
          photoCount: photos.length,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

export function createListingInspectionRouter(): Router {
  return listingRouter
}
