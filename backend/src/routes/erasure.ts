/**
 * Account erasure (NDPA/GDPR right-to-erasure) routes — issue #1900.
 *
 * User (authenticated):
 *   POST   /api/v1/user/erasure   request erasure (fresh OTP / wallet signature required)
 *   GET    /api/v1/user/erasure   latest request status + confirm_by
 *   DELETE /api/v1/user/erasure   cancel the pending request
 *
 * Admin (erasure:manage):
 *   GET    /api/v1/admin/erasure?status=   list requests
 *   POST   /api/v1/admin/erasure/:id/confirm   confirm (anonymise) a pending request
 *
 * Requests are blocked while the user has an active deal or a non-zero NGN
 * wallet balance; the check is repeated at confirmation time.
 */

import { Router, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { erasureRequestStore } from '../models/erasureRequestStore.js'
import type { ErasureRequest } from '../services/erasureService.js'
import {
  createDefaultErasureEligibilityChecks,
  findErasureBlockers,
  verifyErasureReauth,
  type ErasureEligibilityChecks,
} from '../services/erasureGuards.js'
import {
  createErasureRequestSchema,
  erasureRequestIdParamsSchema,
  listErasureRequestsQuerySchema,
  type CreateErasureRequestBody,
  type ListErasureRequestsQuery,
} from '../schemas/erasure.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'
import type { NgnWalletService } from '../services/ngnWalletService.js'

export interface ErasureRouterDeps {
  /** Used by the default wallet-balance check. */
  ngnWalletService?: Pick<NgnWalletService, 'getBalance'>
  /** Override the active-deal / wallet-balance checks (tests). */
  eligibilityChecks?: ErasureEligibilityChecks
}

function resolveChecks(deps: ErasureRouterDeps): ErasureEligibilityChecks {
  return deps.eligibilityChecks ?? createDefaultErasureEligibilityChecks(deps.ngnWalletService)
}

function toDto(request: ErasureRequest) {
  return {
    id: request.id,
    userId: request.userId,
    status: request.status,
    requestedAt: request.requestedAt.toISOString(),
    confirmBy: request.confirmBy.toISOString(),
    confirmedAt: request.confirmedAt ? request.confirmedAt.toISOString() : null,
    confirmedBy: request.confirmedBy,
  }
}

async function assertNoBlockers(userId: string, checks: ErasureEligibilityChecks): Promise<void> {
  const blockers = await findErasureBlockers(userId, checks)
  if (blockers.length > 0) {
    throw new AppError(
      ErrorCode.CONFLICT,
      409,
      `Account cannot be erased yet: ${blockers.map((b) => b.message).join('; ')}`,
      { blockers },
    )
  }
}

function requireUser(req: AuthenticatedRequest) {
  if (!req.user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
  }
  return req.user
}

export function createUserErasureRouter(deps: ErasureRouterDeps = {}): Router {
  const router = Router()
  const checks = resolveChecks(deps)

  router.post(
    '/',
    authenticateToken,
    validate(createErasureRequestSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const body = req.body as CreateErasureRequestBody

        if (await erasureRequestStore.findPendingByUserId(user.id)) {
          throw new AppError(ErrorCode.CONFLICT, 409, 'An erasure request is already pending')
        }

        // Check blockers before consuming the one-time proof.
        await assertNoBlockers(user.id, checks)

        const reauthenticated = await verifyErasureReauth(user, body)
        if (!reauthenticated) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            403,
            'Re-authentication failed: request a new code and try again',
          )
        }

        let request: ErasureRequest
        try {
          request = await erasureRequestStore.requestErasure(user.id)
        } catch (err) {
          if (err instanceof Error && err.message === 'ERASURE_ALREADY_PENDING') {
            throw new AppError(ErrorCode.CONFLICT, 409, 'An erasure request is already pending')
          }
          throw err
        }

        auditLog('USER_ERASURE_REQUESTED', extractAuditContext(req, 'user'), {
          erasureRequestId: request.id,
          confirmBy: request.confirmBy.toISOString(),
          reauthMethod: body.otp ? 'otp' : 'wallet_signature',
        })

        res.status(201).json({ success: true, data: toDto(request) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const request = await erasureRequestStore.findLatestByUserId(user.id)
        res.json({ success: true, data: request ? toDto(request) : null })
      } catch (error) {
        next(error)
      }
    },
  )

  router.delete(
    '/',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const pending = await erasureRequestStore.findPendingByUserId(user.id)
        const cancelled = pending ? await erasureRequestStore.cancelErasure(pending.id) : null
        if (!cancelled) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'No pending erasure request to cancel')
        }

        auditLog('USER_ERASURE_CANCELLED', extractAuditContext(req, 'user'), {
          erasureRequestId: cancelled.id,
        })

        res.json({ success: true, data: toDto(cancelled) })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}

export function createAdminErasureRouter(deps: ErasureRouterDeps = {}): Router {
  const router = Router()
  const checks = resolveChecks(deps)

  router.get(
    '/',
    authenticateToken,
    requirePermission('erasure', 'manage'),
    validate(listErasureRequestsQuerySchema, 'query'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { status, limit, offset } = req.query as unknown as ListErasureRequestsQuery
        const { requests, total } = await erasureRequestStore.list({ status, limit, offset })
        res.json({ success: true, data: requests.map(toDto), total, limit, offset })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/:id/confirm',
    authenticateToken,
    requirePermission('erasure', 'manage'),
    validate(erasureRequestIdParamsSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const admin = requireUser(req)
        const { id } = req.params

        const request = await erasureRequestStore.findById(id)
        if (!request) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Erasure request not found')
        }
        if (request.status !== 'pending') {
          throw new AppError(
            ErrorCode.INVALID_STATE_TRANSITION,
            409,
            `Erasure request is ${request.status}, not pending`,
          )
        }
        if (request.confirmBy.getTime() < Date.now()) {
          throw new AppError(
            ErrorCode.INVALID_STATE_TRANSITION,
            409,
            'Erasure request passed its confirm_by deadline; the user must submit a new request',
          )
        }

        // Re-check: a deal or balance may have appeared since the request.
        await assertNoBlockers(request.userId, checks)

        try {
          await erasureRequestStore.confirmErasure(id, admin.id)
        } catch (err) {
          if (err instanceof Error && err.message === 'ERASURE_NOT_PENDING') {
            throw new AppError(
              ErrorCode.INVALID_STATE_TRANSITION,
              409,
              'Erasure request is no longer pending',
            )
          }
          if (err instanceof Error && err.message === 'ERASURE_NOT_FOUND') {
            throw new AppError(ErrorCode.NOT_FOUND, 404, 'Erasure request not found')
          }
          throw err
        }

        auditLog('USER_ERASURE_COMPLETED', extractAuditContext(req, 'admin'), {
          erasureRequestId: id,
          erasedUserId: request.userId,
        })

        const confirmed = await erasureRequestStore.findById(id)
        res.json({ success: true, data: toDto(confirmed ?? request) })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
