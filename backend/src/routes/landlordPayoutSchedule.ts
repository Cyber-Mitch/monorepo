/**
 * Landlord payout schedule routes — issue #1892. Landlord-only; every query is
 * scoped to the authenticated landlord.
 *
 *   GET /api/v1/landlord/payout-schedule                  periods + summary
 *   GET /api/v1/landlord/payout-schedule/payouts          paginated payout list
 *   GET /api/v1/landlord/payout-schedule/preference       schedule preference
 *   PUT /api/v1/landlord/payout-schedule/preference       update preference
 *   GET /api/v1/landlord/payout-schedule/:payoutId        payout detail (404 if not theirs)
 *
 * Filters: propertyId, status, channel, from, to (ISO datetimes).
 * Creating payouts (settlement) is out of scope.
 */

import { Router, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import {
  landlordPayoutScheduleStore,
  type LandlordPayoutFilters,
} from '../models/landlordPayoutScheduleStore.js'
import {
  listPayoutScheduleSchema,
  payoutScheduleIdParamsSchema,
  updatePayoutSchedulePreferenceSchema,
  type ListPayoutScheduleRequest,
  type UpdatePayoutSchedulePreferenceRequest,
} from '../schemas/landlordPayoutSchedule.js'
import { groupPayoutsIntoPeriods, summarizePayouts } from '../services/landlordPayoutScheduleGrouping.js'

function requireLandlord(req: AuthenticatedRequest) {
  if (!req.user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
  }
  if (req.user.role !== 'landlord') {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only landlords can view payout schedules')
  }
  return req.user
}

function filtersFrom(query: ListPayoutScheduleRequest): LandlordPayoutFilters {
  return {
    propertyId: query.propertyId,
    status: query.status,
    channel: query.channel,
    from: query.from,
    to: query.to,
  }
}

export function createLandlordPayoutScheduleRouter(): Router {
  const router = Router()

  router.get(
    '/',
    authenticateToken,
    validate(listPayoutScheduleSchema, 'query'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireLandlord(req)
        const query = req.query as unknown as ListPayoutScheduleRequest
        const payouts = await landlordPayoutScheduleStore.listForLandlord(
          user.id,
          filtersFrom(query),
        )
        res.json({
          success: true,
          data: {
            periods: groupPayoutsIntoPeriods(payouts, query.grouping),
            summary: summarizePayouts(payouts),
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/payouts',
    authenticateToken,
    validate(listPayoutScheduleSchema, 'query'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireLandlord(req)
        const query = req.query as unknown as ListPayoutScheduleRequest
        const { items, total } = await landlordPayoutScheduleStore.listPageForLandlord(
          user.id,
          filtersFrom(query),
          query.page,
          query.pageSize,
        )
        res.json({
          success: true,
          data: items,
          pagination: {
            total,
            page: query.page,
            pageSize: query.pageSize,
            totalPages: Math.ceil(total / query.pageSize),
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/preference',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireLandlord(req)
        const schedulePreference = await landlordPayoutScheduleStore.getPreference(user.id)
        res.json({ success: true, data: { schedulePreference } })
      } catch (error) {
        next(error)
      }
    },
  )

  router.put(
    '/preference',
    authenticateToken,
    validate(updatePayoutSchedulePreferenceSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireLandlord(req)
        const body = req.body as UpdatePayoutSchedulePreferenceRequest
        const schedulePreference = await landlordPayoutScheduleStore.setPreference(
          user.id,
          body.schedulePreference,
        )
        res.json({ success: true, data: { schedulePreference } })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/:payoutId',
    authenticateToken,
    validate(payoutScheduleIdParamsSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireLandlord(req)
        const payout = await landlordPayoutScheduleStore.findForLandlord(
          user.id,
          req.params.payoutId,
        )
        // Same response for a foreign payout and a missing one.
        if (!payout) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Payout not found')
        }
        res.json({ success: true, data: payout })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
