/**
 * Inspector onboarding and verification routes — issue #1902.
 *
 * Inspector (authenticated, own profile only):
 *   POST /api/v1/inspector/onboarding   create or update the caller's profile
 *                                       { bio, serviceAreas } -> status 'pending'
 *   GET  /api/v1/inspector/me           profile and verification status
 *
 * Admin (inspectors:manage), mounted at /api/v1/admin/inspectors:
 *   GET  /?status=                      list inspector profiles
 *   POST /:userId/verify                verify; requires an approved KYC record
 *   POST /:userId/suspend               suspend
 *
 * Verified status is what grants inspector access: requireVerifiedInspector
 * checks it on every inspection route, so pending and suspended profiles get
 * no access. Verified profiles cannot re-onboard, so their status cannot be
 * reset to pending by the inspector.
 */

import { Router, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import {
  inspectorProfileStore,
  type InspectorProfile,
} from '../models/inspectorProfileStore.js'
import { kycRepository } from '../repositories/KycRepository.js'
import { notificationService } from '../services/notificationService.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'
import { logger } from '../utils/logger.js'
import {
  inspectorOnboardingSchema,
  inspectorUserIdParamSchema,
  listInspectorsQuerySchema,
  type InspectorOnboardingRequest,
} from '../schemas/inspectorOnboarding.js'

function requireUser(req: AuthenticatedRequest) {
  if (!req.user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
  }
  return req.user
}

function toProfileDto(profile: InspectorProfile) {
  return {
    userId: profile.userId,
    verificationStatus: profile.verificationStatus,
    bio: profile.bio,
    serviceAreas: profile.serviceAreas,
    completedInspections: profile.completedInspections,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  }
}

async function hasApprovedKyc(userId: string): Promise<boolean> {
  const record = await kycRepository.findByUserId(userId)
  return record?.status === 'approved'
}

/** Notify the inspector; a failed notification must not undo the status change. */
async function notifyInspector(userId: string, title: string, body: string): Promise<void> {
  try {
    await notificationService.create(userId, {
      category: 'inspector',
      title,
      body,
    })
  } catch (error) {
    logger.warn('inspector.notification_failed', { userId, error: String(error) })
  }
}

export function createInspectorOnboardingRouter(): Router {
  const router = Router()

  router.post(
    '/onboarding',
    authenticateToken,
    validate(inspectorOnboardingSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const body = req.body as InspectorOnboardingRequest

        const existing = await inspectorProfileStore.getByUserId(user.id)
        if (existing?.verificationStatus === 'suspended') {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            403,
            'This inspector account is suspended. Contact support.',
          )
        }
        if (existing?.verificationStatus === 'verified') {
          throw new AppError(
            ErrorCode.CONFLICT,
            409,
            'Your inspector profile is already verified. Contact support to change it.',
          )
        }

        const profile = await inspectorProfileStore.submitOnboarding(user.id, {
          bio: body.bio,
          serviceAreas: body.serviceAreas,
        })

        auditLog('INSPECTOR_ONBOARDING_SUBMITTED', extractAuditContext(req, 'user'), {
          inspectorId: user.id,
          serviceAreas: body.serviceAreas,
        })

        res.status(existing ? 200 : 201).json({ success: true, data: toProfileDto(profile) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/me',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const profile = await inspectorProfileStore.getByUserId(user.id)
        if (!profile) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            404,
            'No inspector profile yet. Complete onboarding first.',
          )
        }
        res.json({ success: true, data: toProfileDto(profile) })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}

const adminRouter = Router()

adminRouter.get(
  '/',
  authenticateToken,
  requirePermission('inspectors', 'manage'),
  validate(listInspectorsQuerySchema, 'query'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { status } = req.query as { status?: InspectorProfile['verificationStatus'] }
      const profiles = await inspectorProfileStore.listByStatus(status)
      res.json({ success: true, data: profiles.map(toProfileDto) })
    } catch (error) {
      next(error)
    }
  },
)

adminRouter.post(
  '/:userId/verify',
  authenticateToken,
  requirePermission('inspectors', 'manage'),
  validate(inspectorUserIdParamSchema, 'params'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const adminId = requireUser(req).id
      const { userId } = req.params

      const profile = await inspectorProfileStore.getByUserId(userId)
      if (!profile) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Inspector profile not found')
      }
      if (profile.verificationStatus === 'verified') {
        res.json({ success: true, data: toProfileDto(profile) })
        return
      }

      if (!(await hasApprovedKyc(userId))) {
        throw new AppError(
          ErrorCode.CONFLICT,
          409,
          'Inspector must have an approved KYC record before verification',
        )
      }

      const updated = await inspectorProfileStore.setVerificationStatus(userId, 'verified')

      auditLog('INSPECTOR_VERIFIED', extractAuditContext(req, 'admin'), {
        inspectorId: userId,
        adminId,
      })
      await notifyInspector(
        userId,
        'Inspector verification approved',
        'Your inspector profile has been verified. You can now accept inspection jobs.',
      )

      res.json({ success: true, data: toProfileDto(updated) })
    } catch (error) {
      next(error)
    }
  },
)

adminRouter.post(
  '/:userId/suspend',
  authenticateToken,
  requirePermission('inspectors', 'manage'),
  validate(inspectorUserIdParamSchema, 'params'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const adminId = requireUser(req).id
      const { userId } = req.params

      const profile = await inspectorProfileStore.getByUserId(userId)
      if (!profile) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Inspector profile not found')
      }
      if (profile.verificationStatus === 'suspended') {
        res.json({ success: true, data: toProfileDto(profile) })
        return
      }

      const updated = await inspectorProfileStore.setVerificationStatus(userId, 'suspended')

      auditLog('INSPECTOR_SUSPENDED', extractAuditContext(req, 'admin'), {
        inspectorId: userId,
        adminId,
      })
      await notifyInspector(
        userId,
        'Inspector account suspended',
        'Your inspector account has been suspended. Contact support for details.',
      )

      res.json({ success: true, data: toProfileDto(updated) })
    } catch (error) {
      next(error)
    }
  },
)

export function createAdminInspectorManagementRouter(): Router {
  return adminRouter
}
