/**
 * Admin routes for property inspections (#1904) and the minimal inspector
 * verification endpoint (subset of #1902).
 *
 * Mounted at /api/v1/admin/inspections (requirePermission('inspections', 'review')):
 *   GET   /                 review queue (filter by status)
 *   GET   /:id              inspection detail incl. checklist + photos
 *   POST  /:id/approve      submitted -> approved; recomputes listing trust
 *                           score and sets has_verified_inspection atomically
 *   POST  /:id/reject       submitted -> rejected (reason required)
 *
 * Mounted at /api/v1/admin/inspectors (requirePermission('inspectors', 'verify')):
 *   PATCH /:userId/verification   set inspector_profiles.verification_status
 *                                 (upserts the profile; no onboarding flow yet)
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { validate } from '../middleware/validate.js'
import { propertyInspectionStore } from '../models/propertyInspectionStore.js'
import {
  inspectorProfileStore,
  type InspectorVerificationStatus,
} from '../models/inspectorProfileStore.js'
import type { PropertyInspectionStatus } from '../models/propertyInspection.js'
import {
  inspectionIdParamSchema,
  inspectorUserIdParamSchema,
  listInspectionsQuerySchema,
  rejectInspectionSchema,
  setInspectorVerificationSchema,
} from '../schemas/propertyInspection.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'
import { invalidTransition, unwrapGuarded } from './propertyInspections.js'

const router = Router()

router.get(
  '/',
  authenticateToken,
  requirePermission('inspections', 'review'),
  validate(listInspectionsQuerySchema, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, limit } = req.query as {
        status?: PropertyInspectionStatus
        limit?: number
      }
      const inspections = await propertyInspectionStore.list({ status, limit })
      res.json({ success: true, data: inspections })
    } catch (error) {
      next(error)
    }
  },
)

router.get(
  '/:id',
  authenticateToken,
  requirePermission('inspections', 'review'),
  validate(inspectionIdParamSchema, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inspection = await propertyInspectionStore.findById(req.params.id)
      if (!inspection) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Inspection not found')
      }
      const [items, photos] = await Promise.all([
        propertyInspectionStore.getChecklistItems(inspection.id),
        propertyInspectionStore.getPhotos(inspection.id),
      ])
      res.json({ success: true, data: { ...inspection, items, photos } })
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/:id/approve',
  authenticateToken,
  requirePermission('inspections', 'review'),
  validate(inspectionIdParamSchema, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as AuthenticatedRequest).user!.id
      const result = await propertyInspectionStore.approve(req.params.id, adminId)

      if (!result.ok) {
        if (result.reason === 'not_found') {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Inspection not found')
        }
        if (result.reason === 'listing_not_found') {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Listing not found')
        }
        throw invalidTransition(result.status, 'approve')
      }

      auditLog('INSPECTION_APPROVED', extractAuditContext(req, 'admin'), {
        inspectionId: result.inspection.id,
        listingId: result.inspection.listingId,
        trustScore: result.trustScore,
      })

      res.json({
        success: true,
        data: { inspection: result.inspection, trustScore: result.trustScore },
      })
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/:id/reject',
  authenticateToken,
  requirePermission('inspections', 'review'),
  validate(inspectionIdParamSchema, 'params'),
  validate(rejectInspectionSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as AuthenticatedRequest).user!.id
      const { reason } = req.body as { reason: string }
      const inspection = unwrapGuarded(
        await propertyInspectionStore.transition(req.params.id, 'submitted', 'rejected', {
          rejectionReason: reason,
          reviewedBy: adminId,
        }),
        'reject',
      )

      auditLog('INSPECTION_REJECTED', extractAuditContext(req, 'admin'), {
        inspectionId: inspection.id,
        listingId: inspection.listingId,
        reason,
      })

      res.json({ success: true, data: inspection })
    } catch (error) {
      next(error)
    }
  },
)

export function createAdminInspectionsRouter(): Router {
  return router
}

const inspectorsRouter = Router()

inspectorsRouter.patch(
  '/:userId/verification',
  authenticateToken,
  requirePermission('inspectors', 'verify'),
  validate(inspectorUserIdParamSchema, 'params'),
  validate(setInspectorVerificationSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params
      const { status } = req.body as { status: InspectorVerificationStatus }
      const profile = await inspectorProfileStore.setVerificationStatus(userId, status)

      auditLog('INSPECTOR_VERIFICATION_UPDATED', extractAuditContext(req, 'admin'), {
        inspectorId: userId,
        status,
      })

      res.json({ success: true, data: profile })
    } catch (error) {
      next(error)
    }
  },
)

export function createAdminInspectorsRouter(): Router {
  return inspectorsRouter
}
