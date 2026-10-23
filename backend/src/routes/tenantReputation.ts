/**
 * Admin tenant reputation routes — issue #1980.
 *
 * All endpoints require `authenticateToken` + `requirePermission('reputation', 'manage')`.
 *
 *   GET  /api/v1/admin/reputation              — paginated list of cached scores
 *   GET  /api/v1/admin/reputation/:tenantId    — single tenant's cached score
 *   POST /api/v1/admin/reputation/:tenantId/sync — force a sync (recompute + enqueue if changed)
 */

import { Router, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { tenantReputationStore } from '../models/tenantReputationStore.js'
import {
  tenantIdParamSchema,
  listReputationQuerySchema,
} from '../schemas/tenantReputation.js'
import { syncTenantReputation } from '../services/tenantReputationService.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'
import { logger } from '../utils/logger.js'

export function createTenantReputationAdminRouter(): Router {
  const router = Router()

  /**
   * GET /
   * List all cached tenant reputation scores, newest-first.
   */
  router.get(
    '/',
    authenticateToken,
    requirePermission('reputation', 'manage'),
    validate(listReputationQuerySchema, 'query'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { limit, offset } = req.query as unknown as {
          limit: number
          offset: number
        }
        const records = await tenantReputationStore.list(limit, offset)
        res.json({ success: true, data: records })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * GET /:tenantId
   * Fetch the cached reputation record for one tenant.
   */
  router.get(
    '/:tenantId',
    authenticateToken,
    requirePermission('reputation', 'manage'),
    validate(tenantIdParamSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = req.params
        const record = await tenantReputationStore.findByTenantId(tenantId)
        if (!record) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            404,
            `No reputation record found for tenant ${tenantId}`,
          )
        }
        res.json({ success: true, data: record })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * POST /:tenantId/sync
   * Recompute and (if changed) enqueue an outbox item for one tenant.
   * Returns the newly stored record.
   */
  router.post(
    '/:tenantId/sync',
    authenticateToken,
    requirePermission('reputation', 'manage'),
    validate(tenantIdParamSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = req.params
        const adminId = req.user!.id

        await syncTenantReputation(tenantId)

        const record = await tenantReputationStore.findByTenantId(tenantId)

        auditLog('TENANT_REPUTATION_SYNCED', extractAuditContext(req, 'admin'), {
          tenantId,
          adminId,
          compositeScore: record?.compositeScore,
        })

        logger.info('Admin triggered tenant reputation sync', { tenantId, adminId })

        res.json({ success: true, data: record ?? null })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
