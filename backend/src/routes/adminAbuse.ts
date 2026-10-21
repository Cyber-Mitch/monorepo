/**
 * Admin routes for abuse detection management
 * GET /api/v1/admin/abuse/events - List abuse events
 * GET /api/v1/admin/abuse/blocks - List active blocks
 * POST /api/v1/admin/abuse/blocks - Create manual block
 * DELETE /api/v1/admin/abuse/blocks/:target - Remove block
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { auditLog, extractAuditContext, type AuditEventType } from '../utils/auditLogger.js'
import { logger } from '../utils/logger.js'
import { abuseStore } from '../models/abuseStore.js'
import {
  listAbuseEventsSchema,
  listAbuseBlocksSchema,
  createManualBlockSchema,
} from '../schemas/abuse.js'

const router = Router()

router.get(
  '/events',
  authenticateToken,
  requirePermission('abuse', 'manage'),
  validate(listAbuseEventsSchema, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type, target } = req.query as any
      const events = await abuseStore.listEvents({
        type: type as string,
        target: target as string,
      })
      res.json({ events })
    } catch (error) {
      next(error)
    }
  },
)

router.get(
  '/blocks',
  authenticateToken,
  requirePermission('abuse', 'manage'),
  validate(listAbuseBlocksSchema, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { targetType, type } = req.query as any
      const blocks = await abuseStore.listBlocks({
        targetType: targetType as 'ip' | 'user',
        type: type as string,
      })
      res.json({ blocks })
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/blocks',
  authenticateToken,
  requirePermission('abuse', 'manage'),
  validate(createManualBlockSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as any).user.id as string
      const { target, targetType, reason, expiryHours } = req.body

      const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000)
      
      await abuseStore.setBlock(target, targetType, 'manual_block', expiresAt, reason, adminId)
      await abuseStore.addEvent({
        target,
        type: 'manual_block',
        expiresAt,
        reason,
      })

      auditLog('MANUAL_BLOCK_CREATED' as AuditEventType, extractAuditContext(req, 'admin'), {
        target,
        targetType,
        reason,
        expiresAt: expiresAt.toISOString(),
      })

      logger.info('Manual block created', { adminId, target, targetType, reason, expiresAt })

      res.json({ success: true, target, targetType, expiresAt })
    } catch (error) {
      next(error)
    }
  },
)

router.delete(
  '/blocks/:target',
  authenticateToken,
  requirePermission('abuse', 'manage'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = (req as any).user.id as string
      const { target } = req.params
      const { targetType } = req.query as { targetType?: 'ip' | 'user' }

      if (!targetType || (targetType !== 'ip' && targetType !== 'user')) {
        throw new AppError(
          ErrorCode.BAD_REQUEST,
          400,
          'targetType query parameter (ip or user) is required',
        )
      }

      const existingBlock = await abuseStore.getBlock(target, targetType)
      if (!existingBlock) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Block not found')
      }

      await abuseStore.removeBlock(target, targetType)

      auditLog('MANUAL_BLOCK_REMOVED' as AuditEventType, extractAuditContext(req, 'admin'), {
        target,
        targetType,
      })

      logger.info('Manual block removed', { adminId, target, targetType })

      res.json({ success: true, target, targetType })
    } catch (error) {
      next(error)
    }
  },
)

export function createAdminAbuseRouter(): Router {
  return router
}
