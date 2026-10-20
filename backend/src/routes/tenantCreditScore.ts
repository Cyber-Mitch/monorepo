/**
 * Tenant credit score routes — issue #1901.
 *
 * Tenant (authenticated, scoped to the caller):
 *   GET /api/v1/tenant/credit-score           latest score, band, factors, tips
 *   GET /api/v1/tenant/credit-score/history   snapshots, newest first (?limit=)
 *
 * Admin (underwriting:view):
 *   GET /api/v1/admin/credit-score/:userId    latest score for any user
 *
 * Scores are read-only here; they are written by underwriting via
 * creditScoreService.recordUnderwritingSnapshot.
 */

import { Router, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { creditScoreService } from '../services/creditScoreService.js'
import type { CreditScoreSnapshot } from '../models/creditScoreSnapshot.js'
import {
  creditScoreHistoryQuerySchema,
  creditScoreUserIdParamsSchema,
  type CreditScoreHistoryQuery,
} from '../schemas/tenantCreditScore.js'

function requireUser(req: AuthenticatedRequest) {
  if (!req.user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
  }
  return req.user
}

function toSnapshotDto(snapshot: CreditScoreSnapshot) {
  return {
    score: snapshot.score,
    band: snapshot.band,
    factors: snapshot.factors,
    computedAt: snapshot.computedAt.toISOString(),
  }
}

function notScoredYet(): AppError {
  return new AppError(
    ErrorCode.NO_SCORE_YET,
    404,
    'Your credit score has not been calculated yet',
  )
}

export function createTenantCreditScoreRouter(): Router {
  const router = Router()

  router.get(
    '/',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const latest = await creditScoreService.getLatestSnapshot(user.id)
        if (!latest) throw notScoredYet()

        res.json({
          success: true,
          data: {
            ...toSnapshotDto(latest),
            tips: creditScoreService.generateImprovementTips(latest),
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/history',
    authenticateToken,
    validate(creditScoreHistoryQuerySchema, 'query'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const { limit } = req.query as unknown as CreditScoreHistoryQuery
        const snapshots = await creditScoreService.getHistory(user.id, limit)

        res.json({
          success: true,
          data: snapshots.map((snapshot) => ({
            score: snapshot.score,
            band: snapshot.band,
            computedAt: snapshot.computedAt.toISOString(),
          })),
        })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}

export function createAdminCreditScoreRouter(): Router {
  const router = Router()

  router.get(
    '/:userId',
    authenticateToken,
    requirePermission('underwriting', 'view'),
    validate(creditScoreUserIdParamsSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { userId } = req.params
        const latest = await creditScoreService.getLatestSnapshot(userId)
        if (!latest) throw notScoredYet()

        res.json({
          success: true,
          data: {
            userId,
            ...toSnapshotDto(latest),
            tips: creditScoreService.generateImprovementTips(latest),
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
