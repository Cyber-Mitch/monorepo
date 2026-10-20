import { Router, Response } from 'express'
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { quotaManager } from '../services/QuotaManager.js'
import { burstRateLimiter } from '../services/BurstRateLimiter.js'
import { validate } from '../middleware/validate.js'
import { z } from 'zod'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'

const router = Router()

// Schemas for validation
const createOverrideSchema = z.object({
  userId: z.string().min(1),
  endpoint: z.string().optional(),
  elevatedLimit: z.number().min(1).max(10000),
  reason: z.string().min(1).max(500),
  expiresAt: z.number().optional(),
})

const removeOverrideSchema = z.object({
  userId: z.string().min(1),
  endpoint: z.string().optional(),
})

/**
 * Get quota usage for a user
 * GET /api/admin/quota/usage/:userId
 */
router.get(
  '/usage/:userId',
  authenticateToken,
  requirePermission('quota', 'view'),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { userId } = req.params
      const endpoint = req.query.endpoint as string | undefined

      const usage = await quotaManager.getQuotaUsage(userId, endpoint || 'all')
      res.json(usage)
    } catch (error) {
      next(error)
    }
  }
)

/**
 * Get all quota overrides for a user
 * GET /api/admin/quota/overrides/:userId
 */
router.get(
  '/overrides/:userId',
  authenticateToken,
  requirePermission('quota', 'view'),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { userId } = req.params
      const overrides = await quotaManager.getUserOverrides(userId)
      res.json({ overrides })
    } catch (error) {
      next(error)
    }
  }
)

/**
 * Create a quota override (admin function)
 * POST /api/admin/quota/override
 */
router.post(
  '/override',
  authenticateToken,
  requirePermission('quota', 'manage'),
  validate(createOverrideSchema, 'body'),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { userId, endpoint, elevatedLimit, reason, expiresAt } = req.body

      const override = await quotaManager.setOverride({
        userId,
        endpoint,
        elevatedLimit,
        reason,
        createdBy: req.user!.id,
        createdAt: Date.now(),
        expiresAt,
      })

      auditLog('ADMIN_QUOTA_OVERRIDE_CREATED', extractAuditContext(req, 'admin'), {
        userId,
        endpoint,
        elevatedLimit,
        reason,
        expiresAt,
      })

      res.status(201).json({ success: true, override })
    } catch (error) {
      next(error)
    }
  }
)

/**
 * Remove a quota override (admin function)
 * DELETE /api/admin/quota/override
 */
router.delete(
  '/override',
  authenticateToken,
  requirePermission('quota', 'manage'),
  validate(removeOverrideSchema, 'body'),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { userId, endpoint } = req.body

      await quotaManager.removeOverride(userId, endpoint)

      auditLog('ADMIN_QUOTA_OVERRIDE_REMOVED', extractAuditContext(req, 'admin'), {
        userId,
        endpoint,
      })

      res.json({ success: true })
    } catch (error) {
      next(error)
    }
  }
)

/**
 * Get quota statistics
 * GET /api/admin/quota/stats
 */
router.get(
  '/stats',
  authenticateToken,
  requirePermission('quota', 'view'),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const stats = await quotaManager.getQuotaStats()
      res.json(stats)
    } catch (error) {
      next(error)
    }
  }
)

/**
 * Reset quota for a user (admin function)
 * POST /api/admin/quota/reset
 */
router.post(
  '/reset',
  authenticateToken,
  requirePermission('quota', 'manage'),
  validate(z.object({ userId: z.string().min(1), endpoint: z.string().optional() }), 'body'),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { userId, endpoint } = req.body
      const key = `ratelimit:user:${userId}${endpoint ? `:${endpoint}` : ''}`

      await burstRateLimiter.resetQuota(key)

      auditLog('ADMIN_QUOTA_RESET', extractAuditContext(req, 'admin'), {
        userId,
        endpoint,
      })

      res.json({ success: true })
    } catch (error) {
      next(error)
    }
  }
)

export function createAdminQuotaRouter(): Router {
  return router
}
