import { Router, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { userStore } from '../models/authStore.js'
import { notificationPreferenceStore } from '../models/notificationPreferenceStore.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { sanitiseForClient } from '../utils/sanitiseForClient.js'

const updatePreferencesSchema = z.object({
  displayCurrency: z.enum(['NGN', 'USDC']),
})

const updateMessageEmailPreferenceSchema = z.object({
  enabled: z.boolean(),
})

export function createUserPreferencesRouter(): Router {
  const router = Router()

  /**
   * PATCH /api/user/preferences
   * Update user display preferences (requires auth).
   */
  router.patch(
    '/preferences',
    authenticateToken,
    validate(updatePreferencesSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = req.user?.id
        const email = req.user?.email
        if (!userId || !email) {
          throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
        }

        const { displayCurrency } = req.body as z.infer<typeof updatePreferencesSchema>
        const updated = await userStore.updateDisplayCurrency(email, displayCurrency)

        res.json({
          displayCurrency: updated.displayCurrency,
          user: sanitiseForClient({
            id: updated.id,
            email: updated.email,
            name: updated.name,
            role: updated.role,
            displayCurrency: updated.displayCurrency,
          }),
        })
      } catch (error) {
        next(error)
      }
    },
  )

  router.patch(
    '/preferences/notifications/messages-email',
    authenticateToken,
    validate(updateMessageEmailPreferenceSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = req.user?.id
        if (!userId) {
          throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
        }

        const { enabled } =
          req.body as z.infer<typeof updateMessageEmailPreferenceSchema>

        if (enabled) {
          await notificationPreferenceStore.optIn(userId, 'message_received', 'email')
        } else {
          await notificationPreferenceStore.optOut(userId, 'message_received', 'email')
        }

        res.json({
          messageEmailsEnabled: enabled,
        })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
