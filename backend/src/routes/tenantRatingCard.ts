/**
 * Tenant rating card routes — issue #1905.
 *
 * Landlord (mounted at /api/v1/deals):
 *   POST /:dealId/tenant-rating           rate the deal's tenant; deal landlord only,
 *                                         once per deal, deal completed or active for
 *                                         MIN_TENURE_MONTHS_FOR_RATING months
 *
 * Tenant (mounted at /api/v1/tenant/rating-card):
 *   GET    /                              own aggregate: averages, count, recent comments
 *   POST   /share                         { ttlDays <= 30 } -> token and URL, token shown once
 *   DELETE /share/:id                     revoke a share link
 *
 * Public (mounted at /api/v1/public/rating-card):
 *   GET /:token                           aggregate with first name and last initial only;
 *                                         404 for unknown, expired or revoked tokens
 */

import { Router, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { createRateLimiter } from '../middleware/rateLimiter.js'
import { rateLimitProfiles } from '../config/rateLimitConfig.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { dealStore } from '../models/dealStore.js'
import { userStore } from '../models/authStore.js'
import {
  DuplicateTenantRatingError,
  tenantRatingStore,
  type TenantRatingRecord,
} from '../models/tenantRatingStore.js'
import {
  aggregateRatings,
  checkRatingEligibility,
  computeOverallScore,
  generateShareToken,
  hashShareToken,
  maskDisplayName,
  MIN_TENURE_MONTHS_FOR_RATING,
  shareExpiryFrom,
} from '../services/tenantRatingCard.js'
import { scheduleSyncTenantReputation } from '../services/tenantReputationService.js'
import {
  createRatingCardShareSchema,
  createTenantRatingSchema,
  dealIdParamSchema,
  publicRatingCardTokenParamSchema,
  SHARE_TOKEN_DEFAULT_TTL_DAYS,
  shareIdParamSchema,
  type CreateRatingCardShareRequest,
  type CreateTenantRatingRequest,
} from '../schemas/tenantRatingCard.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'

function requireUser(req: AuthenticatedRequest) {
  if (!req.user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
  }
  return req.user
}

function toRatingDto(rating: TenantRatingRecord) {
  return {
    id: rating.id,
    dealId: rating.dealId,
    scores: {
      paymentTimeliness: rating.paymentTimeliness,
      propertyCare: rating.propertyCare,
      communication: rating.communication,
      overall: rating.overall,
    },
    comment: rating.comment,
    createdAt: rating.createdAt.toISOString(),
  }
}

export function createLandlordTenantRatingRouter(): Router {
  const router = Router()

  router.post(
    '/:dealId/tenant-rating',
    authenticateToken,
    validate(dealIdParamSchema, 'params'),
    validate(createTenantRatingSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const { dealId } = req.params
        const body = req.body as CreateTenantRatingRequest

        const deal = await dealStore.findById(dealId)
        if (!deal) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
        }
        if (deal.landlordId !== user.id) {
          throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only the landlord of this deal can rate the tenant')
        }

        const eligibility = checkRatingEligibility(deal, new Date())
        if (!eligibility.eligible) {
          const message =
            eligibility.reason === 'tenure_too_short'
              ? `A tenant can be rated once the deal has run for ${MIN_TENURE_MONTHS_FOR_RATING} months`
              : 'Only completed or active deals can be rated'
          throw new AppError(ErrorCode.CONFLICT, 409, message)
        }

        const scores = {
          paymentTimeliness: body.paymentTimeliness,
          propertyCare: body.propertyCare,
          communication: body.communication,
        }
        let rating: TenantRatingRecord
        try {
          rating = await tenantRatingStore.createRating({
            tenantId: deal.tenantId,
            landlordId: user.id,
            dealId,
            ...scores,
            overall: computeOverallScore(scores),
            comment: body.comment ?? null,
          })
        } catch (error) {
          if (error instanceof DuplicateTenantRatingError) {
            throw new AppError(ErrorCode.CONFLICT, 409, 'This deal has already been rated')
          }
          throw error
        }

        auditLog('TENANT_RATING_CREATED', extractAuditContext(req, 'user'), {
          dealId,
          landlordId: user.id,
          ratingId: rating.id,
        })

        // Trigger a debounced reputation sync so the new rating is reflected
        // in the on-chain tenant reputation record (#1980).
        scheduleSyncTenantReputation(deal.tenantId)

        res.status(201).json({ success: true, data: toRatingDto(rating) })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}

export function createTenantRatingCardRouter(): Router {
  const router = Router()

  router.get(
    '/',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const ratings = await tenantRatingStore.listRatingsForTenant(user.id)
        res.json({ success: true, data: aggregateRatings(ratings) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/share',
    authenticateToken,
    validate(createRatingCardShareSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const body = req.body as Partial<CreateRatingCardShareRequest> | undefined
        const ttlDays = body?.ttlDays ?? SHARE_TOKEN_DEFAULT_TTL_DAYS

        // The raw token is returned once and never stored, only its hash.
        const token = generateShareToken()
        const share = await tenantRatingStore.createShare({
          tenantId: user.id,
          tokenHash: hashShareToken(token),
          expiresAt: shareExpiryFrom(new Date(), ttlDays),
        })

        auditLog('RATING_CARD_SHARE_CREATED', extractAuditContext(req, 'user'), {
          shareId: share.id,
          ttlDays,
        })

        res.status(201).json({
          success: true,
          data: {
            id: share.id,
            token,
            url: `/api/v1/public/rating-card/${token}`,
            expiresAt: share.expiresAt.toISOString(),
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  router.delete(
    '/share/:id',
    authenticateToken,
    validate(shareIdParamSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const { id } = req.params

        const revoked = await tenantRatingStore.revokeShare(user.id, id)
        if (!revoked) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Share link not found')
        }

        auditLog('RATING_CARD_SHARE_REVOKED', extractAuditContext(req, 'user'), { shareId: id })

        res.json({ success: true, data: { id, revoked: true } })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}

export function createPublicRatingCardRouter(): Router {
  const router = Router()

  router.get(
    '/:token',
    createRateLimiter(rateLimitProfiles.publicRatingCard),
    validate(publicRatingCardTokenParamSchema, 'params'),
    async (req, res: Response, next: NextFunction) => {
      // Share responses are per-recipient and must never be cached by an intermediary.
      res.setHeader('Cache-Control', 'no-store')
      try {
        const share = await tenantRatingStore.findShareByTokenHash(hashShareToken(req.params.token))
        if (!share || share.expiresAt.getTime() <= Date.now()) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Rating card not found')
        }

        const [ratings, tenant] = await Promise.all([
          tenantRatingStore.listRatingsForTenant(share.tenantId),
          userStore.getById(share.tenantId),
        ])

        res.json({
          success: true,
          data: {
            displayName: maskDisplayName(tenant?.name),
            ...aggregateRatings(ratings),
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
