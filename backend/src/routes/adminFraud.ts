import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { getFraudStore } from '../fraud/store.js'
import { getFraudEngine } from '../fraud/engine.js'
import { SignalType, RiskLevel, ActionType, EntityType } from '../fraud/types.js'
import { outboxStore } from '../outbox/store.js'
import { TxType } from '../outbox/types.js'
import { requireAdminAccess, getAdminActor } from '../middleware/adminAccess.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'
import { notificationService } from '../services/notificationService.js'
import { logger } from '../utils/logger.js'

const createSignalSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  signalType: z.nativeEnum(SignalType),
  config: z.record(z.unknown()),
  enabled: z.boolean().optional(),
  scoreWeight: z.number().int().min(1).max(100).optional(),
})

const updateSignalSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  signalType: z.nativeEnum(SignalType).optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  scoreWeight: z.number().int().min(1).max(100).optional(),
})

const evaluateEventSchema = z.object({
  entityType: z.nativeEnum(EntityType),
  entityId: z.string().min(1),
  eventData: z.record(z.unknown()),
  metadata: z.record(z.unknown()).optional(),
})

const listAssessmentsQuerySchema = z.object({
  riskLevel: z.nativeEnum(RiskLevel).optional(),
  decision: z.nativeEnum(ActionType).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const listHoldsQuerySchema = z.object({
  status: z.enum(['active', 'released']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const releaseHoldSchema = z.object({
  reason: z.string().min(1).max(1000),
})

const updateThresholdsSchema = z.object({
  medium: z.number().int().min(0).optional(),
  high: z.number().int().min(0).optional(),
  critical: z.number().int().min(0).optional(),
})

const submitEvidenceSchema = z.object({
  submitter: z.string().min(1),
  commitment: z.string().min(1),
  actor: z.string().min(1),
  offence: z.string().min(1),
})

const revealEvidenceSchema = z.object({
  submitter: z.string().min(1),
  slashId: z.number().int().min(0),
  evidence: z.string().min(1),
  salt: z.string().min(1),
})

const proposeSlashSchema = z.object({
  submitter: z.string().min(1),
  actor: z.string().min(1),
  penaltyBps: z.number().int().min(0).max(10000),
})

const finalizeSlashSchema = z.object({
  caller: z.string().min(1),
  slashId: z.number().int().min(0),
})

const cancelSlashSchema = z.object({
  admin: z.string().min(1),
  slashId: z.number().int().min(0),
})

const depositBondSchema = z.object({
  inspector: z.string().min(1),
  amount: z.union([z.string(), z.number()]),
})

const withdrawBondSchema = z.object({
  inspector: z.string().min(1),
  amount: z.union([z.string(), z.number()]),
})

export function createAdminFraudRouter() {
  const router = Router()

  // ---------------------------------------------------------------------------
  // Signal Management
  // ---------------------------------------------------------------------------

  /**
   * GET /api/admin/fraud/signals
   * List all fraud signals
   */
  router.get('/signals', requireAdminAccess('fraud', 'view'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const enabled = req.query.enabled === 'true' ? true : req.query.enabled === 'false' ? false : undefined
      const signals = await getFraudStore().listSignals({ enabled })
      res.json({ signals })
    } catch (err) {
      next(err)
    }
  })

  /**
   * GET /api/admin/fraud/signals/:id
   * Get a single fraud signal
   */
  router.get('/signals/:id', requireAdminAccess('fraud', 'view'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const signal = await getFraudStore().getSignal(req.params.id)
      if (!signal) throw new AppError(ErrorCode.NOT_FOUND, 404, `Signal ${req.params.id} not found`)
      res.json({ signal })
    } catch (err) {
      next(err)
    }
  })

  /**
   * POST /api/admin/fraud/signals
   * Create a new fraud signal
   */
  router.post(
    '/signals',
    requireAdminAccess('fraud', 'manage'),
    validate(createSignalSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as z.infer<typeof createSignalSchema>
        const signal = await getFraudStore().createSignal(body)
        res.status(201).json({ signal })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * PUT /api/admin/fraud/signals/:id
   * Update a fraud signal
   */
  router.put(
    '/signals/:id',
    requireAdminAccess('fraud', 'manage'),
    validate(updateSignalSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as z.infer<typeof updateSignalSchema>
        const signal = await getFraudStore().updateSignal(req.params.id, body)
        res.json({ signal })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * DELETE /api/admin/fraud/signals/:id
   * Delete a fraud signal
   */
  router.delete('/signals/:id', requireAdminAccess('fraud', 'manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await getFraudStore().deleteSignal(req.params.id)
      res.json({ success: true })
    } catch (err) {
      next(err)
    }
  })

  /**
   * POST /api/admin/fraud/signals/:id/enable
   * Enable a fraud signal
   */
  router.post('/signals/:id/enable', requireAdminAccess('fraud', 'manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await getFraudStore().enableSignal(req.params.id)
      res.json({ success: true })
    } catch (err) {
      next(err)
    }
  })

  /**
   * POST /api/admin/fraud/signals/:id/disable
   * Disable a fraud signal
   */
  router.post('/signals/:id/disable', requireAdminAccess('fraud', 'manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await getFraudStore().disableSignal(req.params.id)
      res.json({ success: true })
    } catch (err) {
      next(err)
    }
  })

  // ---------------------------------------------------------------------------
  // Assessment Management
  // ---------------------------------------------------------------------------

  /**
   * POST /api/admin/fraud/evaluate
   * Manually evaluate an event against fraud signals
   */
  router.post(
    '/evaluate',
    requireAdminAccess('fraud', 'manage'),
    validate(evaluateEventSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as z.infer<typeof evaluateEventSchema>
        const engine = getFraudEngine()
        const assessment = await engine.evaluate(body)
        res.json({ assessment })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * GET /api/admin/fraud/assessments
   * List fraud assessments (newest first) with optional filters
   */
  router.get(
    '/assessments',
    requireAdminAccess('fraud', 'view'),
    validate(listAssessmentsQuerySchema, 'query'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const q = req.query as unknown as z.infer<typeof listAssessmentsQuerySchema>

        // page/pageSize take priority; fall back to limit/offset
        const pageSize = q.pageSize ?? q.limit ?? 50
        const offset = q.page ? (q.page - 1) * pageSize : q.offset ?? 0

        const assessments = await getFraudStore().listAssessments({
          riskLevel: q.riskLevel,
          decision: q.decision,
          from: q.from ? new Date(q.from) : undefined,
          to: q.to ? new Date(q.to) : undefined,
          limit: pageSize,
          offset,
        })
        res.json({ assessments })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * GET /api/admin/fraud/assessments/:id
   * Get a single assessment
   */
  router.get('/assessments/:id', requireAdminAccess('fraud', 'view'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assessment = await getFraudStore().getAssessment(req.params.id)
      if (!assessment) throw new AppError(ErrorCode.NOT_FOUND, 404, `Assessment ${req.params.id} not found`)
      res.json({ assessment })
    } catch (err) {
      next(err)
    }
  })

  /**
   * GET /api/admin/fraud/assessments/entity/:type/:id
   * Get assessments for a specific entity
   */
  router.get(
    '/assessments/entity/:type/:id',
    requireAdminAccess('fraud', 'view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const entityType = req.params.type as EntityType
        const entityId = req.params.id
        const limit = parseInt(req.query.limit as string) || 50
        const assessments = await getFraudStore().getAssessmentsByEntity(entityType, entityId, limit)
        res.json({ assessments })
      } catch (err) {
        next(err)
      }
    },
  )

  // ---------------------------------------------------------------------------
  // Account Hold Management
  // ---------------------------------------------------------------------------

  /**
   * GET /api/admin/fraud/holds
   * List holds for the review queue (newest first)
   */
  router.get(
    '/holds',
    requireAdminAccess('fraud', 'view'),
    validate(listHoldsQuerySchema, 'query'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const q = req.query as unknown as z.infer<typeof listHoldsQuerySchema>

        // page/pageSize take priority; fall back to limit/offset
        const pageSize = q.pageSize ?? q.limit ?? 50
        const offset = q.page ? (q.page - 1) * pageSize : q.offset ?? 0

        const holds = await getFraudStore().listHolds({
          status: q.status,
          limit: pageSize,
          offset,
        })
        res.json({ holds })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * GET /api/admin/fraud/holds/:accountId
   * Get active holds for an account
   */
  router.get('/holds/:accountId', requireAdminAccess('fraud', 'view'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const holds = await getFraudStore().getActiveHolds(req.params.accountId)
      res.json({ holds })
    } catch (err) {
      next(err)
    }
  })

  /**
   * POST /api/admin/fraud/holds/:id/release
   * Release an account hold with a reason, audit-logged with the acting admin
   * and the affected user notified.
   */
  router.post(
    '/holds/:id/release',
    requireAdminAccess('fraud', 'manage', { audit: false }),
    validate(releaseHoldSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { reason } = req.body as z.infer<typeof releaseHoldSchema>
        const adminId = getAdminActor(req).id

        let hold
        try {
          hold = await getFraudStore().releaseHold(req.params.id, adminId, reason)
        } catch (storeErr) {
          const msg = storeErr instanceof Error ? storeErr.message : String(storeErr)
          if (msg.includes('not found')) {
            throw new AppError(ErrorCode.NOT_FOUND, 404, `Hold ${req.params.id} not found`)
          }
          if (msg.includes('already released')) {
            throw new AppError(ErrorCode.CONFLICT, 409, `Hold ${req.params.id} already released`)
          }
          throw storeErr
        }

        // Audit log with the acting admin and release reason
        auditLog('ADMIN_OPERATION', extractAuditContext(req, 'admin'), {
          resource: 'fraud',
          action: 'manage',
          holdId: hold.id,
          accountId: hold.accountId,
          reason,
          adminId,
        })

        // Notify the affected user
        try {
          await notificationService.create(hold.accountId, {
            category: 'fraud_hold_released',
            title: 'Account hold released',
            body: `Your account hold has been released by an administrator. Reason: ${reason}`,
          })
        } catch (notifErr) {
          logger.warn('Failed to notify user of hold release', {
            holdId: hold.id,
            accountId: hold.accountId,
            error: notifErr instanceof Error ? notifErr.message : String(notifErr),
          })
        }

        res.json({ success: true, hold })
      } catch (err) {
        next(err)
      }
    },
  )

  // ---------------------------------------------------------------------------
  // Threshold Management
  // ---------------------------------------------------------------------------

  /**
   * GET /api/admin/fraud/thresholds
   * Get current risk thresholds
   */
  router.get('/thresholds', requireAdminAccess('fraud', 'view'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const engine = getFraudEngine()
      const thresholds = engine.getThresholds()
      res.json({ thresholds })
    } catch (err) {
      next(err)
    }
  })

  /**
   * PUT /api/admin/fraud/thresholds
   * Update risk thresholds
   */
  router.put(
    '/thresholds',
    requireAdminAccess('fraud', 'manage'),
    validate(updateThresholdsSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as z.infer<typeof updateThresholdsSchema>
        const engine = getFraudEngine()
        engine.updateThresholds(body)
        const thresholds = engine.getThresholds()
        res.json({ thresholds })
      } catch (err) {
        next(err)
      }
    },
  )

  // ---------------------------------------------------------------------------
  // Slashing Module Operations
  // ---------------------------------------------------------------------------

  /**
   * POST /api/admin/fraud/slashing/submit-evidence
   * Submit evidence to the slashing module
   */
  router.post(
    '/slashing/submit-evidence',
    requireAdminAccess('fraud', 'manage'),
    validate(submitEvidenceSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as z.infer<typeof submitEvidenceSchema>
        const item = await outboxStore.create({
          txType: TxType.SLASHING_SUBMIT_EVIDENCE,
          source: 'admin',
          ref: `submit-evidence-${Date.now()}`,
          payload: body,
        })
        res.status(201).json({ success: true, outboxId: item.id })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * POST /api/admin/fraud/slashing/reveal-evidence
   * Reveal evidence in the slashing module
   */
  router.post(
    '/slashing/reveal-evidence',
    requireAdminAccess('fraud', 'manage'),
    validate(revealEvidenceSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as z.infer<typeof revealEvidenceSchema>
        const item = await outboxStore.create({
          txType: TxType.SLASHING_REVEAL_EVIDENCE,
          source: 'admin',
          ref: `reveal-evidence-${body.slashId}-${Date.now()}`,
          payload: body,
        })
        res.status(201).json({ success: true, outboxId: item.id })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * POST /api/admin/fraud/slashing/propose-slash
   * Propose a slash in the slashing module
   */
  router.post(
    '/slashing/propose-slash',
    requireAdminAccess('fraud', 'manage'),
    validate(proposeSlashSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as z.infer<typeof proposeSlashSchema>
        const item = await outboxStore.create({
          txType: TxType.SLASHING_PROPOSE_SLASH,
          source: 'admin',
          ref: `propose-slash-${body.actor}-${Date.now()}`,
          payload: body,
        })
        res.status(201).json({ success: true, outboxId: item.id })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * POST /api/admin/fraud/slashing/finalize-slash
   * Finalize a slash in the slashing module
   */
  router.post(
    '/slashing/finalize-slash',
    requireAdminAccess('fraud', 'manage'),
    validate(finalizeSlashSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as z.infer<typeof finalizeSlashSchema>
        const item = await outboxStore.create({
          txType: TxType.SLASHING_FINALIZE_SLASH,
          source: 'admin',
          ref: `finalize-slash-${body.slashId}-${Date.now()}`,
          payload: body,
        })
        res.status(201).json({ success: true, outboxId: item.id })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * POST /api/admin/fraud/slashing/cancel-slash
   * Cancel a slash in the slashing module
   */
  router.post(
    '/slashing/cancel-slash',
    requireAdminAccess('fraud', 'manage'),
    validate(cancelSlashSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as z.infer<typeof cancelSlashSchema>
        const item = await outboxStore.create({
          txType: TxType.SLASHING_CANCEL_SLASH,
          source: 'admin',
          ref: `cancel-slash-${body.slashId}-${Date.now()}`,
          payload: body,
        })
        res.status(201).json({ success: true, outboxId: item.id })
      } catch (err) {
        next(err)
      }
    },
  )

  // ---------------------------------------------------------------------------
  // Bond Collateral Operations
  // ---------------------------------------------------------------------------

  /**
   * POST /api/admin/fraud/bond/deposit
   * Deposit bond to the bond collateral contract
   */
  router.post(
    '/bond/deposit',
    requireAdminAccess('fraud', 'manage'),
    validate(depositBondSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as z.infer<typeof depositBondSchema>
        const item = await outboxStore.create({
          txType: TxType.BOND_DEPOSIT,
          source: 'admin',
          ref: `deposit-bond-${body.inspector}-${Date.now()}`,
          payload: body,
        })
        res.status(201).json({ success: true, outboxId: item.id })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * POST /api/admin/fraud/bond/withdraw
   * Withdraw bond from the bond collateral contract
   */
  router.post(
    '/bond/withdraw',
    requireAdminAccess('fraud', 'manage'),
    validate(withdrawBondSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as z.infer<typeof withdrawBondSchema>
        const item = await outboxStore.create({
          txType: TxType.BOND_WITHDRAW,
          source: 'admin',
          ref: `withdraw-bond-${body.inspector}-${Date.now()}`,
          payload: body,
        })
        res.status(201).json({ success: true, outboxId: item.id })
      } catch (err) {
        next(err)
      }
    },
  )

  return router
}
