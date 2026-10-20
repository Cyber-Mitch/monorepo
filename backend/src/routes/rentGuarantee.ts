/**
 * Rent guarantee insurance for landlords (#1908).
 *
 *  POST /deals/:dealId/rent-guarantee/quote
 *  GET  /rent-guarantee/policies
 *  POST /rent-guarantee/policies/:id/bind     (idempotent)
 *  POST /rent-guarantee/policies/:id/cancel
 *  POST /rent-guarantee/policies/:id/claims
 *
 * A landlord only ever sees or acts on policies for their own deals; anyone
 * else's deal or policy is reported as 404 so ids cannot be probed.
 */
import { Router, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { idempotency } from '../middleware/idempotency.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { dealStore } from '../models/dealStore.js'
import {
  rentGuaranteeStore as defaultStore,
  canTransitionPolicy,
  type RentGuaranteePolicy,
  type RentGuaranteeClaim,
  type RentGuaranteeStore,
} from '../models/rentGuaranteeStore.js'
import { createRentGuaranteeProvider, type RentGuaranteeProvider } from '../services/insurance/index.js'
import {
  cancelPolicySchema,
  dealIdParamSchema,
  fileClaimSchema,
  policyIdParamSchema,
} from '../schemas/rentGuarantee.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'

export interface RentGuaranteeRouterOptions {
  /** Defaults to the module singleton so `initRentGuaranteeStore()` swaps are honoured. */
  store?: RentGuaranteeStore
  provider?: RentGuaranteeProvider
}

function serializePolicy(p: RentGuaranteePolicy) {
  return {
    id: p.id,
    dealId: p.dealId,
    provider: p.provider,
    policyNumber: p.policyNumber,
    premiumNgn: p.premiumNgn,
    coverageTermMonths: p.coverageTermMonths,
    status: p.status,
    activatedAt: p.activatedAt?.toISOString() ?? null,
    cancelledAt: p.cancelledAt?.toISOString() ?? null,
    cancellationReason: p.cancellationReason,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }
}

function serializeClaim(c: RentGuaranteeClaim) {
  return {
    id: c.id,
    policyId: c.policyId,
    amountNgn: c.amountNgn,
    reason: c.reason,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
  }
}

export function createRentGuaranteeRouter(options: RentGuaranteeRouterOptions = {}): Router {
  const router = Router()
  const getStore = () => options.store ?? defaultStore
  let lazyProvider: RentGuaranteeProvider | undefined = options.provider
  const getProvider = () => (lazyProvider ??= createRentGuaranteeProvider())

  async function loadOwnedPolicy(policyId: string, userId: string): Promise<RentGuaranteePolicy> {
    const policy = await getStore().findPolicyById(policyId)
    if (!policy || policy.landlordId !== userId) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, 'Rent guarantee policy not found')
    }
    return policy
  }

  function invalidTransition(policy: RentGuaranteePolicy, action: string): AppError {
    return new AppError(
      ErrorCode.INVALID_STATE_TRANSITION,
      409,
      `Cannot ${action} a policy that is ${policy.status}`,
    )
  }

  router.post(
    '/deals/:dealId/rent-guarantee/quote',
    authenticateToken,
    validate(dealIdParamSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.id
        const deal = await dealStore.findById(req.params.dealId as string)
        if (!deal || deal.landlordId !== userId) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
        }

        const store = getStore()
        const open = await store.findOpenPolicyForDeal(deal.dealId)
        if (open?.status === 'active') {
          throw new AppError(ErrorCode.CONFLICT, 409, 'This deal already has an active rent guarantee')
        }
        if (open) {
          // Re-quoting returns the outstanding quote instead of stacking duplicates.
          res.json({ policy: serializePolicy(open) })
          return
        }

        const provider = getProvider()
        const quote = await provider.quote({
          dealId: deal.dealId,
          landlordId: userId,
          annualRentNgn: deal.annualRentNgn,
          termMonths: deal.termMonths,
          sequence: (await store.countPoliciesForDeal(deal.dealId)) + 1,
        })
        const policy = await store.createPolicy({
          dealId: deal.dealId,
          landlordId: userId,
          provider: provider.name,
          policyNumber: quote.policyNumber,
          premiumNgn: quote.premiumNgn,
          coverageTermMonths: quote.coverageTermMonths,
        })

        auditLog('INSURANCE_QUOTE_REQUESTED', extractAuditContext(req, 'user'), {
          policyId: policy.id,
          dealId: deal.dealId,
          premiumNgn: policy.premiumNgn,
        })
        res.status(201).json({ policy: serializePolicy(policy) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/rent-guarantee/policies',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const policies = await getStore().listPoliciesByLandlord(req.user!.id)
        res.json({ policies: policies.map(serializePolicy) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/rent-guarantee/policies/:id/bind',
    authenticateToken,
    idempotency(),
    validate(policyIdParamSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const store = getStore()
        const policy = await loadOwnedPolicy(req.params.id as string, req.user!.id)

        // Binding twice is a no-op, not an error, so client retries are safe.
        if (policy.status === 'active') {
          res.json({ policy: serializePolicy(policy) })
          return
        }
        if (!canTransitionPolicy(policy.status, 'active')) throw invalidTransition(policy, 'bind')

        const bound = await getProvider().bind(policy)
        const active = await store.transitionPolicy(policy.id, 'quoted', 'active', {
          providerReference: bound.providerReference,
        })
        if (!active) {
          // Lost a race: report whatever state the policy ended up in.
          const current = await loadOwnedPolicy(policy.id, req.user!.id)
          if (current.status === 'active') {
            res.json({ policy: serializePolicy(current) })
            return
          }
          throw invalidTransition(current, 'bind')
        }

        auditLog('INSURANCE_POLICY_PURCHASED', extractAuditContext(req, 'user'), {
          policyId: active.id,
          dealId: active.dealId,
          premiumNgn: active.premiumNgn,
        })
        res.json({ policy: serializePolicy(active) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/rent-guarantee/policies/:id/cancel',
    authenticateToken,
    validate(policyIdParamSchema, 'params'),
    validate(cancelPolicySchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const store = getStore()
        const policy = await loadOwnedPolicy(req.params.id as string, req.user!.id)
        if (!canTransitionPolicy(policy.status, 'cancelled')) throw invalidTransition(policy, 'cancel')

        const reason = req.body?.reason as string | undefined
        // Only a bound policy exists on the insurer's side.
        if (policy.status === 'active') await getProvider().cancel(policy, reason)

        const cancelled = await store.transitionPolicy(policy.id, policy.status, 'cancelled', {
          cancellationReason: reason,
        })
        if (!cancelled) {
          throw invalidTransition(await loadOwnedPolicy(policy.id, req.user!.id), 'cancel')
        }

        auditLog('INSURANCE_POLICY_CANCELLED', extractAuditContext(req, 'user'), {
          policyId: cancelled.id,
          dealId: cancelled.dealId,
        })
        res.json({ policy: serializePolicy(cancelled) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/rent-guarantee/policies/:id/claims',
    authenticateToken,
    validate(policyIdParamSchema, 'params'),
    validate(fileClaimSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const store = getStore()
        const policy = await loadOwnedPolicy(req.params.id as string, req.user!.id)
        if (!canTransitionPolicy(policy.status, 'claimed')) throw invalidTransition(policy, 'claim against')

        const { amountNgn, reason } = req.body as { amountNgn: number; reason: string }
        const deal = await dealStore.findById(policy.dealId)
        if (deal && amountNgn > deal.annualRentNgn) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            400,
            'Claim amount cannot exceed the deal annual rent',
          )
        }

        const filed = await getProvider().fileClaim(policy, { amountNgn, reason })
        const result = await store.fileClaim(policy.id, {
          amountNgn,
          reason,
          providerReference: filed.providerReference,
        })
        if (!result) {
          throw invalidTransition(await loadOwnedPolicy(policy.id, req.user!.id), 'claim against')
        }

        auditLog('INSURANCE_CLAIM_FILED', extractAuditContext(req, 'user'), {
          policyId: policy.id,
          claimId: result.claim.id,
          amountNgn,
        })
        res.status(201).json({ claim: serializeClaim(result.claim), policy: serializePolicy(result.policy) })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
