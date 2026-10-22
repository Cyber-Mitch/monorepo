/**
 * Deal management routes
 */

import { Router, Request, Response } from 'express'
import { dealStore } from '../models/dealStore.js'
import { listingStore } from '../models/listingStore.js'
import { ListingStatus } from '../models/listing.js'
import { 
  createDealSchema, 
  dealFiltersSchema, 
  updateDealStatusSchema,
  updateScheduleItemSchema,
  CreateDealRequest,
  DealFiltersRequest,
  UpdateDealStatusRequest,
  UpdateScheduleItemRequest
} from '../schemas/deal.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { outboxStore } from '../outbox/index.js'
import { TxType } from '../outbox/types.js'
import { computeDealProgress } from '../services/dealProgress.js'
import { detectDuplicateDealSpam } from '../services/abuseDetectionService.js'
import { enqueueDelivery } from '../services/webhookDeliveryService.js'
import { WebhookEventType } from '../models/webhookSubscription.js'
import { logger } from '../utils/logger.js'
import { recordDealActivationDuration } from '../metrics.js'
import { applyDealRepaymentMethod } from '../services/salaryDeductionService.js'
import { updateDealRepaymentSchema } from '../schemas/employer.js'
import { durableApiIdempotency } from '../middleware/durableApiIdempotency.js'
import { dealStateMachine } from '../services/deals/DealStateMachine.js'
import { wouldExceedEquityCap } from '../services/deals/rentToOwnConversion.js'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'

const router = Router()


function callerId(req: Request): string | undefined {
  return (req as AuthenticatedRequest).user?.id
}

function isAdmin(req: Request): boolean {
  const role = (req as AuthenticatedRequest).user?.role
  return role === 'admin' || role === 'super_admin'
}

/** Loads a deal, then requires the caller to be its tenant, its landlord or an admin. */
async function loadDealForParty(req: Request, dealId: string) {
  const deal = await dealStore.findById(dealId)
  if (!deal) {
    throw new AppError(ErrorCode.NOT_FOUND, 404, `Deal with ID ${dealId} not found`)
  }
  const userId = callerId(req)
  if (!isAdmin(req) && userId !== deal.tenantId && userId !== deal.landlordId) {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'You are not authorized to access this deal')
  }
  return deal
}



/**
 * POST /api/deals
 * Create a new deal with repayment schedule
 * 
 * RACE CONDITION HANDLING:
 * Uses transactional compare-and-lock (SELECT ... FOR UPDATE) in Postgres,
 * or atomic in-memory check-and-set. This ensures only one deal can be
 * created per listing even under concurrent load.
 * 
 * Approach: First atomically lock the listing (check availability + lock in one transaction),
 * then create the deal. If deal creation fails, the listing remains locked (caller must handle cleanup).
 */
router.post('/', authenticateToken, durableApiIdempotency(), async (req: Request, res: Response, next) => {
  try {
    const validatedData: CreateDealRequest = createDealSchema.parse(req.body)

    const userId = callerId(req)
    if (!isAdmin(req) && userId !== validatedData.tenantId && userId !== validatedData.landlordId) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        403,
        'You can only create a deal where you are the tenant or the landlord'
      )
    }
    if (userId && validatedData.listingId) {
      const flagged = await detectDuplicateDealSpam(String(userId), validatedData.listingId)
      if (flagged) {
        throw new AppError(
          ErrorCode.TOO_MANY_REQUESTS,
          429,
          'Your account is temporarily blocked from submitting deal applications.'
        )
      }
    }

    // Atomically lock listing to deal FIRST (validation + lock in single transaction)
    // This prevents race conditions where two concurrent requests both pass validation
    if (validatedData.listingId) {
      const result = await listingStore.tryLockToDeal(validatedData.listingId, 'pending')
      if (result.error) {
        throw new AppError(
          ErrorCode.LISTING_ALREADY_RENTED,
          409,
          result.error
        )
      }
    }

    // Create the deal after listing is locked
    const deal = await dealStore.create(validatedData as any)

    dealStateMachine
      .enqueueRentToOwnRegistration(deal)
      .catch((err) => logger.error('Failed to enqueue rent_to_own registration:', err))

    if (validatedData.repaymentMethod === 'salary_deduction') {
      await applyDealRepaymentMethod(deal.dealId, 'salary_deduction', {
        employerId: validatedData.employerId,
        employeeId: validatedData.employeeId,
        deductionDay: validatedData.deductionDay,
      })
    }

    // Update the listing with the actual deal ID (was 'pending' during lock)
    if (validatedData.listingId) {
      await listingStore.lockToDeal(validatedData.listingId, deal.dealId)
    }

    const responseDeal = await dealStore.findById(deal.dealId)

    res.status(201).json({
      success: true,
      data: responseDeal ?? deal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * GET /api/deals/:dealId/progress
 * Get a deal's payment progress computed from on-chain receipts
 */
router.get('/:dealId/progress', authenticateToken, async (req: Request, res: Response, next) => {
  try {
    const { dealId } = req.params

    if (!dealId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Deal ID is required')
    }

    const deal = await loadDealForParty(req, dealId)

    // Fetch all outbox items for this deal filtered to TENANT_REPAYMENT
    const receipts = await outboxStore.listByDealId(dealId, TxType.TENANT_REPAYMENT)
    // Contract-confirmed rent_to_own equity payments (only SENT = confirmed on-chain)
    const equityPayments = await outboxStore.listByDealId(dealId, TxType.RENT_TO_OWN_EQUITY_PAYMENT)

    const progress = computeDealProgress(deal, receipts, equityPayments)

    res.json({
      success: true,
      data: progress,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /api/deals/:dealId
 * Get a specific deal by ID with schedule
 */
router.get('/:dealId', authenticateToken, async (req: Request, res: Response, next) => {
  try {
    const { dealId } = req.params
    
    if (!dealId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Deal ID is required')
    }
    
    const deal = await loadDealForParty(req, dealId)

    res.json({
      success: true,
      data: deal
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /api/deals
 * Get deals with optional filtering
 */
router.get('/', authenticateToken, async (req: Request, res: Response, next) => {
  try {
    const validatedFilters: DealFiltersRequest = dealFiltersSchema.parse(req.query)

    // Non-admins may only list deals they are party to, so they must filter by their own id.
    const userId = callerId(req)
    if (!isAdmin(req) && validatedFilters.tenantId !== userId && validatedFilters.landlordId !== userId) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        403,
        'Filter deals by your own tenantId or landlordId'
      )
    }

    const result = await dealStore.findMany(validatedFilters)
    
    res.json({
      success: true,
      data: result
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * PATCH /api/deals/:dealId/status
 * Update deal status
 */
router.patch('/:dealId/status', authenticateToken, async (req: Request, res: Response, next) => {
  const { dealId } = req.params
  
  if (!dealId) {
    return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Deal ID is required'))
  }
  
  try {
    const validatedData: UpdateDealStatusRequest = updateDealStatusSchema.parse(req.body)
    const activationStart =
      validatedData.status === 'active' ? Date.now() : null

    await loadDealForParty(req, dealId)
    const deal = await dealStore.updateStatus(dealId, validatedData.status)
    
    if (!deal) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, `Deal with ID ${dealId} not found`)
    }

    if (deal) {
      let eventType: WebhookEventType | undefined
      if (validatedData.status === 'active') {
        if (activationStart !== null) {
          recordDealActivationDuration(Date.now() - activationStart)
        }
        eventType = WebhookEventType.DEAL_ACTIVATED

        // Generate and save repayment schedule on activation
        try {
          const { generateSchedule, saveSchedule } = await import('../services/repaymentScheduleService.js')
          
          // Determine plan based on term months
          const planMap: Record<number, '3m' | '6m' | '12m' | 'outright'> = {
            3: '3m',
            6: '6m',
            12: '12m',
          }
          const plan = planMap[deal.termMonths] || '12m'
          
          const schedule = generateSchedule({
            dealId: deal.dealId,
            startDate: deal.createdAt,
            plan,
            installmentBasePriceNgn: deal.annualRentNgn,
            depositPct: Math.round((deal.depositNgn / deal.annualRentNgn) * 100),
          })
          
          await saveSchedule(
            deal.dealId,
            schedule.schedule,
            schedule.depositAmountNgn,
            schedule.financedBalanceNgn,
            schedule.interestAmountNgn,
            schedule.totalRepaymentNgn
          )
          
          logger.info('Repayment schedule generated and saved on deal activation', {
            dealId: deal.dealId,
            plan,
            totalRepaymentNgn: schedule.totalRepaymentNgn,
          })
        } catch (scheduleError) {
          logger.error('Failed to generate repayment schedule on activation', {
            dealId: deal.dealId,
            error: scheduleError,
          })
        }
      } else if (validatedData.status === 'completed') {
        eventType = WebhookEventType.DEAL_COMPLETED
      } else if (validatedData.status === 'defaulted') {
        eventType = WebhookEventType.DEAL_DEFAULTED
      }

      if (eventType) {
        await enqueueDelivery(eventType, {
          dealId: deal.dealId,
          status: deal.status,
          listingId: deal.listingId,
          tenantId: deal.tenantId,
          landlordId: deal.landlordId,
          totalFinancedAmount: deal.financedAmountNgn
        }, { requestId: req.requestId }).catch(err => logger.error('Failed to enqueue deal webhook:', err))
      }
    }

    
    res.json({
      success: true,
      data: deal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * PATCH /api/deals/:dealId/schedule/:period
 * Update schedule item status
 */
router.patch('/:dealId/schedule/:period', authenticateToken, async (req: Request, res: Response, next) => {
  const { dealId } = req.params
  const period = parseInt(req.params.period, 10)
  
  if (!dealId || isNaN(period)) {
    return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Deal ID and period are required'))
  }
  
  try {
    const validatedData: UpdateScheduleItemRequest = updateScheduleItemSchema.parse({
      ...req.body,
      period
    })

    const existingDeal = await loadDealForParty(req, dealId)

    let targetItem: { period: number; amountNgn: number } | undefined
    if (validatedData.status === 'paid') {
      targetItem = existingDeal.schedule.find((item) => item.period === validatedData.period)
      if (!targetItem) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          404,
          `Schedule period ${validatedData.period} not found for deal ${dealId}`
        )
      }
      if (wouldExceedEquityCap(existingDeal, existingDeal.schedule, targetItem.amountNgn)) {
        throw new AppError(
          ErrorCode.EQUITY_OVERFLOW,
          409,
          `Recording this payment would push accumulated rent-to-own equity over the property value for deal ${dealId}`
        )
      }
    }

    const deal = await dealStore.updateScheduleItemStatus(
      dealId,
      validatedData.period,
      validatedData.status as any
    )

    if (!deal) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, `Deal with ID ${dealId} not found`)
    }

    if (validatedData.status === 'paid' && targetItem) {
      dealStateMachine
        .enqueueRentToOwnEquityPayment(deal, targetItem)
        .catch((err) => logger.error('Failed to enqueue rent_to_own equity payment:', err))
    }

    res.json({
      success: true,
      data: deal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * PATCH /api/deals/:dealId/repayment
 * Update repayment method and salary deduction linkage
 */
router.patch('/:dealId/repayment', authenticateToken, async (req: Request, res: Response, next) => {
  const { dealId } = req.params
  if (!dealId) {
    return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Deal ID is required'))
  }
  try {
    const body = updateDealRepaymentSchema.parse(req.body)
    await loadDealForParty(req, dealId)
    await applyDealRepaymentMethod(dealId, body.repaymentMethod, {
      employerId: body.employerId,
      employeeId: body.employeeId,
      deductionDay: body.deductionDay,
    })
    const deal = await dealStore.findById(dealId)
    res.json({ success: true, data: deal })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * GET /api/deals/:dealId/schedule
 * Get repayment schedule for a deal
 * Authenticated; tenant or landlord of the deal can view
 */
router.get('/:dealId/schedule', authenticateToken, async (req: Request, res: Response, next) => {
  try {
    const { dealId } = req.params
    
    if (!dealId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Deal ID is required')
    }

    await loadDealForParty(req, dealId)

    const { getSchedule } = await import('../services/repaymentScheduleService.js')
    const schedule = await getSchedule(dealId)
    
    if (!schedule) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, `Repayment schedule not found for deal ${dealId}`)
    }
    
    res.json({
      success: true,
      data: schedule
    })
  } catch (error) {
    next(error)
  }
})

export function createDealsRouter(): Router {
  return router
}
