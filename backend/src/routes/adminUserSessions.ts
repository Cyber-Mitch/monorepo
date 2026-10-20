/**
 * Admin session management (#1907): inspect and force-logout a user's sessions,
 * e.g. when responding to a compromised account.
 */
import { Router, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { auditAdminUserSessionsRevoked } from '../utils/auditLogger.js'

const userIdParamSchema = z.object({ userId: z.string().uuid() })

export function createAdminUserSessionsRouter(): Router {
  const router = Router()

  async function loadTarget(userId: string) {
    const user = await userStore.getById(userId)
    if (!user) throw new AppError(ErrorCode.NOT_FOUND, 404, 'User not found')
    return user
  }

  router.get(
    '/:userId/sessions',
    authenticateToken,
    requirePermission('users', 'manage'),
    validate(userIdParamSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = await loadTarget(req.params.userId as string)
        const sessions = await sessionStore.listActiveSessions(user.id, user.email)
        res.json({ sessions })
      } catch (error) {
        next(error)
      }
    },
  )

  router.delete(
    '/:userId/sessions',
    authenticateToken,
    requirePermission('users', 'manage'),
    validate(userIdParamSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = await loadTarget(req.params.userId as string)
        const count = await sessionStore.revokeAllSessions(user.id, user.email)
        auditAdminUserSessionsRevoked(req, { targetUserId: user.id, sessionCount: count })
        res.json({ revoked: count })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
