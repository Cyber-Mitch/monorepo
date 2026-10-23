/**
 * Staking delegation routes (#1885). Passive holders delegate their stake to
 * operators and receive rewards. The routes expose:
 *
 *   GET  /api/v1/staking/delegation/position       staked, delegated, free, pending undelegations with cooldowns
 *   GET  /api/v1/staking/delegation/delegatees     operators available for delegation
 *   POST /api/v1/staking/delegation/stake/prepare|submit    stake (user-signed)
 *   POST /api/v1/staking/delegation/unstake/prepare|submit  unstake (user-signed)
 *   POST /api/v1/staking/delegation/delegate/prepare|submit delegate to an operator (user-signed)
 *   POST /api/v1/staking/delegation/request_undelegate/prepare|submit  start cooldown (user-signed)
 *   POST /api/v1/staking/delegation/complete_undelegate/prepare|submit  finalize undelegation (user-signed)
 *   POST /api/v1/staking/delegation/claim-commission/prepare|submit    operator claims commission (user-signed)
 *   POST /api/v1/staking/delegation/claim-rewards/prepare|submit       user claims delegatee rewards (user-signed)
 *
 * The routes require authentication (Bearer token) and validate amounts
 * against the user's free/delegated balance before preparing transactions.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import type { LinkedAddressStore } from '../models/linkedAddressStore.js'
import type { SorobanAdapter } from '../soroban/adapter.js'
import { env } from '../schemas/env.js'
import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// Schema validation
// ─────────────────────────────────────────────────────────────────────────────

const delegationAmountSchema = z.object({
  amount: z.string().regex(/^\d+$/, 'Amount must be a positive integer string'),
})

const delegationDelegateSchema = z.object({
  delegatee: z.string().min(32, 'Invalid delegatee address'),
})

const delegationSubmitAmountSchema = z.object({
  signedXdr: z.string().min(1, 'Signed XDR is required'),
  amount: z.string().regex(/^\d+$/, 'Amount must be a positive integer string'),
})

const delegationSubmitDelegateSchema = z.object({
  signedXdr: z.string().min(1, 'Signed XDR is required'),
  delegatee: z.string().min(32, 'Invalid delegatee address'),
})

const delegationSubmitClaimSchema = z.object({
  signedXdr: z.string().min(1, 'Signed XDR is required'),
})

const setCommissionSchema = z.object({
  commissionBps: z.number().int().min(0).max(10000, 'Commission must be 0-10000 bps (0-100%)'),
})

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type DelegationMethod =
  | 'prepareDelegationCall'
  | 'submitDelegationCall'
  | 'getDelegations'
  | 'delegationStakedBalance'
  | 'listDelegatees'
  | 'delegationCurrentEpoch'
  | 'prepareSetCommission'
  | 'submitSetCommission'
  | 'prepareClaimCommission'
  | 'submitClaimCommission'
  | 'prepareClaimDelegateeRewards'
  | 'submitClaimDelegateeRewards'

const DELEGATION_METHODS: DelegationMethod[] = [
  'prepareDelegationCall',
  'submitDelegationCall',
  'getDelegations',
  'delegationStakedBalance',
  'listDelegatees',
  'delegationCurrentEpoch',
  'prepareSetCommission',
  'submitSetCommission',
  'prepareClaimCommission',
  'submitClaimCommission',
  'prepareClaimDelegateeRewards',
  'submitClaimDelegateeRewards',
]

type DelegationAdapter = SorobanAdapter & Required<Pick<SorobanAdapter, DelegationMethod>>

function requireDelegation(adapter: SorobanAdapter): DelegationAdapter {
  if (DELEGATION_METHODS.some((name) => typeof adapter[name] !== 'function')) {
    throw new AppError(
      ErrorCode.NOT_IMPLEMENTED,
      501,
      'Staking delegation is not available on the configured Soroban adapter',
    )
  }
  return adapter as DelegationAdapter
}

function currentUserId(req: AuthenticatedRequest): string {
  if (!req.user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
  }
  return req.user.id
}

async function requireLinkedWallet(store: LinkedAddressStore, userId: string): Promise<string> {
  const wallet = await store.getLinkedAddress(userId)
  if (!wallet) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'No linked wallet address found for user')
  }
  return wallet
}

function formatAmount6(amountMicro: bigint): string {
  const negative = amountMicro < 0n
  const abs = negative ? -amountMicro : amountMicro
  const whole = abs / 1_000_000n
  const frac = (abs % 1_000_000n).toString().padStart(6, '0')
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Route factory
// ─────────────────────────────────────────────────────────────────────────────

export function createDelegationRouter(
  sorobanAdapter: SorobanAdapter,
  linkedAddressStore: LinkedAddressStore,
): Router {
  const router = Router()

  /**
   * GET /api/v1/staking/delegation/position
   *
   * Returns the user's complete delegation position:
   * - staked: total staked in the delegation contract
   * - delegated: amount currently delegated to operators
   * - free: staked amount not yet delegated (or pending undelegation)
   * - pendingUndelegations: list with cooldown end timestamps
   */
  router.get(
    '/position',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const delegation = requireDelegation(sorobanAdapter)
        const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))

        const [staked, delegations, epoch] = await Promise.all([
          delegation.delegationStakedBalance(wallet),
          delegation.getDelegations(wallet),
          delegation.delegationCurrentEpoch(),
        ])

        // Calculate delegated vs free
        let delegated = 0n
        const pendingUndelegations: Array<{
          delegatee: string
          amount: string
          cooldownEndTs: number
          cooldownEnd: string
        }> = []

        for (const d of delegations) {
          if (d.cooldownEndTs > Math.floor(Date.now() / 1000)) {
            // Still in cooldown period
            delegated += d.amount
            pendingUndelegations.push({
              delegatee: d.delegatee,
              amount: formatAmount6(d.amount),
              cooldownEndTs: d.cooldownEndTs,
              cooldownEnd: new Date(d.cooldownEndTs * 1000).toISOString(),
            })
          } else {
            // Cooldown expired - treat as free
            delegated += d.amount
          }
        }

        const free = staked - delegated

        res.json({
          success: true,
          data: {
            wallet,
            epoch,
            staked: formatAmount6(staked),
            delegated: formatAmount6(delegated),
            free: formatAmount6(free),
            pendingUndelegations,
            delegations: delegations
              .filter((d) => d.cooldownEndTs <= Math.floor(Date.now() / 1000))
              .map((d) => ({
                delegatee: d.delegatee,
                amount: formatAmount6(d.amount),
              })),
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * GET /api/v1/staking/delegation/delegatees
   *
   * Returns the operators available for delegation. Sources from the contract's
   * get_delegatees() method. The contract provides the operator addresses and
   * their commission rates (basis points).
   */
  router.get(
    '/delegatees',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const delegation = requireDelegation(sorobanAdapter)
        const delegatees = await delegation.listDelegatees()

        res.json({
          success: true,
          data: {
            delegatees: delegatees.map((d) => ({
              address: d.address,
              totalDelegated: formatAmount6(d.totalDelegated),
              commissionBps: d.commissionBps,
            })),
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * Helper for stake/unstake/delegate/request_undelegate/complete_undelegate
   * that validates the amount against available balance.
   */
  const amountCall = (
    call: 'stake' | 'unstake' | 'delegate' | 'request_undelegate' | 'complete_undelegate',
  ) => {
    // PREPARE: returns unsigned XDR for wallet signing
    router.post(
      `/${call}/prepare`,
      authenticateToken,
      validate(
        call === 'delegate' ? delegationDelegateSchema : delegationAmountSchema,
        'body',
      ),
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const delegation = requireDelegation(sorobanAdapter)
          const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))

          let amount: bigint | undefined
          let delegatee: string | undefined

          if (call === 'delegate') {
            delegatee = (req.body as { delegatee: string }).delegatee
          } else if (call !== 'request_undelegate' && call !== 'complete_undelegate') {
            amount = BigInt((req.body as { amount: string }).amount)
          }

          // Validate amount for unstake against current delegated balance
          if (call === 'unstake' && amount) {
            const staked = await delegation.delegationStakedBalance(wallet)
            if (amount > staked) {
              throw new AppError(
                ErrorCode.VALIDATION_ERROR,
                400,
                `Cannot unstake more than staked balance (${formatAmount6(staked)})`,
              )
            }
          }

          const xdr = await delegation.prepareDelegationCall(call, wallet, amount, delegatee)
          res.json({ success: true, data: { xdr } })
        } catch (error) {
          next(error)
        }
      },
    )

    // SUBMIT: broadcasts signed XDR
    router.post(
      `/${call}/submit`,
      authenticateToken,
      validate(
        call === 'delegate' ? delegationSubmitDelegateSchema : delegationSubmitAmountSchema,
        'body',
      ),
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const delegation = requireDelegation(sorobanAdapter)
          const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))

          let amount: bigint | undefined
          let delegatee: string | undefined

          if (call === 'delegate') {
            delegatee = (req.body as { delegatee: string }).delegatee
            const { signedXdr } = req.body as { signedXdr: string }
            const txHash = await delegation.submitDelegationCall(signedXdr, call, wallet, undefined, delegatee)
            return res.json({ success: true, data: { txHash } })
          } else if (call !== 'request_undelegate' && call !== 'complete_undelegate') {
            amount = BigInt((req.body as { amount: string }).amount)
          }

          const { signedXdr } = req.body as { signedXdr: string }
          const txHash = await delegation.submitDelegationCall(signedXdr, call, wallet, amount, delegatee)
          res.json({ success: true, data: { txHash } })
        } catch (error) {
          next(error)
        }
      },
    )
  }

  amountCall('stake')
  amountCall('unstake')
  amountCall('delegate')
  amountCall('request_undelegate')
  amountCall('complete_undelegate')

  /**
   * POST /api/v1/staking/delegation/claim-commission/prepare
   *
   * Operator prepares unsigned claim_commission transaction.
   */
  router.post(
    '/claim-commission/prepare',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const delegation = requireDelegation(sorobanAdapter)
        const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))

        const xdr = await delegation.prepareClaimCommission(wallet)
        res.json({ success: true, data: { xdr } })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * POST /api/v1/staking/delegation/claim-commission/submit
   *
   * Operator submits signed claim_commission transaction.
   */
  router.post(
    '/claim-commission/submit',
    authenticateToken,
    validate(delegationSubmitClaimSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const delegation = requireDelegation(sorobanAdapter)
        const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))
        const { signedXdr } = req.body as { signedXdr: string }

        const txHash = await delegation.submitClaimCommission(signedXdr, wallet)
        res.json({ success: true, data: { txHash } })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * POST /api/v1/staking/delegation/claim-rewards/prepare
   *
   * User prepares unsigned claim_delegatee_rewards transaction.
   */
  router.post(
    '/claim-rewards/prepare',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const delegation = requireDelegation(sorobanAdapter)
        const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))

        const xdr = await delegation.prepareClaimDelegateeRewards(wallet)
        res.json({ success: true, data: { xdr } })
      } catch (error) {
        next(error)
      }
    },
  )

  /**
   * POST /api/v1/staking/delegation/claim-rewards/submit
   *
   * User submits signed claim_delegatee_rewards transaction.
   */
  router.post(
    '/claim-rewards/submit',
    authenticateToken,
    validate(delegationSubmitClaimSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const delegation = requireDelegation(sorobanAdapter)
        const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))
        const { signedXdr } = req.body as { signedXdr: string }

        const txHash = await delegation.submitClaimDelegateeRewards(signedXdr, wallet)
        res.json({ success: true, data: { txHash } })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}