/**
 * Partner landlord applications (#1909).
 *
 *  POST  /landlord/partner-application   public, rate-limited intake form
 *  GET   /admin/partner-applications     landlords:manage
 *  PATCH /admin/partner-applications/:id landlords:manage
 *
 * A second submission from the same email within 24 hours is rejected with 409
 * rather than merged, so the form never silently rewrites a lead an admin may
 * already be working.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { validate } from '../middleware/validate.js'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { createRateLimiter } from '../middleware/rateLimiter.js'
import { rateLimitProfiles } from '../config/rateLimitConfig.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { logger } from '../utils/logger.js'
import {
  partnerLandlordApplicationStore,
  type PartnerLandlordApplication,
} from '../models/partnerLandlordApplicationStore.js'
import {
  createPartnerLandlordApplicationSchema,
  listPartnerApplicationsSchema,
  partnerApplicationIdParamSchema,
  updatePartnerApplicationSchema,
  type CreatePartnerLandlordApplicationRequest,
} from '../schemas/partnerLandlordApplication.js'

const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000

function serialize(a: PartnerLandlordApplication) {
  return {
    id: a.id,
    fullName: a.fullName,
    phone: a.phone,
    email: a.email,
    propertyCount: a.propertyCount,
    propertyLocations: a.propertyLocations,
    status: a.status,
    reviewedBy: a.reviewedBy,
    reviewedAt: a.reviewedAt ? a.reviewedAt.toISOString() : null,
    notes: a.notes,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }
}

export function createPartnerLandlordApplicationsRouter(): Router {
  const router = Router()
  const submitLimiter = createRateLimiter(rateLimitProfiles.partnerApplication)

  router.post(
    '/',
    submitLimiter,
    validate(createPartnerLandlordApplicationSchema, 'body'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const data = req.body as CreatePartnerLandlordApplicationRequest

        const recent = await partnerLandlordApplicationStore.findRecentByEmail(
          data.email,
          new Date(Date.now() - DUPLICATE_WINDOW_MS),
        )
        if (recent) {
          throw new AppError(
            ErrorCode.CONFLICT,
            409,
            'We already received an application from this email in the last 24 hours.',
          )
        }

        const application = await partnerLandlordApplicationStore.create(data)
        logger.info('Partner landlord application submitted', {
          applicationId: application.id,
          requestId: req.requestId,
        })

        res.status(201).json({
          success: true,
          application: {
            id: application.id,
            status: application.status,
            createdAt: application.createdAt.toISOString(),
          },
          message: 'Application submitted. Our team will be in touch shortly.',
        })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}

export function createAdminPartnerApplicationsRouter(): Router {
  const router = Router()

  router.get(
    '/',
    authenticateToken,
    requirePermission('landlords', 'manage'),
    validate(listPartnerApplicationsSchema, 'query'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { status, page, pageSize } = req.query as unknown as {
          status?: PartnerLandlordApplication['status']
          page: number
          pageSize: number
        }
        const result = await partnerLandlordApplicationStore.list({ status, page, pageSize })
        res.json({
          applications: result.applications.map(serialize),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        })
      } catch (error) {
        next(error)
      }
    },
  )

  router.patch(
    '/:id',
    authenticateToken,
    requirePermission('landlords', 'manage'),
    validate(partnerApplicationIdParamSchema, 'params'),
    validate(updatePartnerApplicationSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const updated = await partnerLandlordApplicationStore.update(req.params.id as string, {
          status: req.body.status,
          notes: req.body.notes,
          reviewedBy: req.user!.id,
        })
        if (!updated) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Partner application not found')
        }
        logger.info('Partner landlord application reviewed', {
          applicationId: updated.id,
          status: updated.status,
          reviewedBy: req.user!.id,
          requestId: req.requestId,
        })
        res.json({ application: serialize(updated) })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
