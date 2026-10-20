import { Router, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { validate } from '../middleware/validate.js'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { NgnWalletService } from '../services/ngnWalletService.js'
import { withdrawalResponseSchema } from '../schemas/ngnWallet.js'
import { AppError } from '../errors/AppError.js'
import { logger } from '../utils/logger.js'

const listWithdrawalsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'processing', 'confirmed', 'failed', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(200).optional(),
})

const rejectWithdrawalSchema = z.object({
  reason: z.string().min(1, 'Reason is required'),
})

export function createAdminWithdrawalsRouter(ngnWalletService: NgnWalletService): Router {
  const router = Router()

  /**
   * GET /withdrawals?status=&limit=&cursor=
   * Every user's withdrawals, newest first, so admins can see what is waiting for approval.
   * Same permission as approve and reject.
   */
  router.get(
    '/withdrawals',
    authenticateToken,
    requirePermission('payouts', 'trigger'),
    validate(listWithdrawalsQuerySchema, 'query'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { status, limit, cursor } = req.query as unknown as z.infer<typeof listWithdrawalsQuerySchema>
        const page = await ngnWalletService.listAllWithdrawals({ status, limit, cursor })
        res.json({ success: true, data: page })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/withdrawals/:id/approve',
    authenticateToken,
    requirePermission('payouts', 'trigger'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params
        const withdrawal = await ngnWalletService.approveWithdrawal(id, req.user!.id)
        
        logger.info('Withdrawal approved by admin', {
          adminId: req.user!.id,
          withdrawalId: id,
          requestId: req.requestId,
        })

        res.json(withdrawalResponseSchema.parse({ success: true, ...withdrawal }))
      } catch (error) {
        if (error instanceof AppError) {
          res.status(error.status).json({ error: { code: error.code, message: error.message } })
        } else {
          next(error)
        }
      }
    },
  )

  router.post(
    '/withdrawals/:id/reject',
    authenticateToken,
    requirePermission('payouts', 'trigger'),
    validate(rejectWithdrawalSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params
        const { reason } = req.body as { reason: string }
        const withdrawal = await ngnWalletService.rejectWithdrawal(id, reason)

        logger.info('Withdrawal rejected by admin', {
          adminId: req.user!.id,
          withdrawalId: id,
          reason,
          requestId: req.requestId,
        })

        res.json(withdrawalResponseSchema.parse({ success: true, ...withdrawal }))
      } catch (error) {
        if (error instanceof AppError) {
          res.status(error.status).json({ error: { code: error.code, message: error.message } })
        } else {
          next(error)
        }
      }
    },
  )

  return router
}
