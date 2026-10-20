/**
 * Epoch rewards routes (#1965). Stakers see their position and claim by signing
 * transactions in their own wallet; admins fund and seal epochs with the admin key.
 *
 *   GET  /api/v1/epoch-rewards/me                       staked, claimable and the current epoch for the linked wallet
 *   GET  /api/v1/epoch-rewards/epochs/:n                one epoch
 *   POST /api/v1/epoch-rewards/stake/prepare|submit     stake (user-signed)
 *   POST /api/v1/epoch-rewards/unstake/prepare|submit   unstake (user-signed)
 *   POST /api/v1/epoch-rewards/claim/prepare|submit     claim (user-signed)
 *   POST /api/v1/admin/epoch-rewards/fund               add to the current epoch's pool (rewards:manage)
 *   POST /api/v1/admin/epoch-rewards/seal               seal the current epoch if it has ended (rewards:manage)
 *
 * Amounts are decimal strings, since they are i128 values.
 */

import { Router, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import type { LinkedAddressStore } from '../models/linkedAddressStore.js'
import type { EpochRewardsCall, EpochRewardsEpoch, SorobanAdapter } from '../soroban/adapter.js'
import { sealEpochIfDue, supportsEpochSealing } from '../services/epochSealService.js'
import {
  epochAmountSchema,
  epochNumberParamsSchema,
  epochSubmitAmountSchema,
  epochSubmitClaimSchema,
  fundEpochSchema,
  sealEpochSchema,
} from '../schemas/epochRewards.js'

type EpochMethod =
  | 'epochRewardsCurrentEpoch'
  | 'epochRewardsGetEpoch'
  | 'epochRewardsTotalStaked'
  | 'epochRewardsGetClaimable'
  | 'epochRewardsGetStake'
  | 'epochRewardsFund'
  | 'epochRewardsSeal'
  | 'prepareEpochRewardsCall'
  | 'submitEpochRewardsCall'

const EPOCH_METHODS: EpochMethod[] = [
  'epochRewardsCurrentEpoch',
  'epochRewardsGetEpoch',
  'epochRewardsTotalStaked',
  'epochRewardsGetClaimable',
  'epochRewardsGetStake',
  'epochRewardsFund',
  'epochRewardsSeal',
  'prepareEpochRewardsCall',
  'submitEpochRewardsCall',
]

type EpochAdapter = SorobanAdapter & Required<Pick<SorobanAdapter, EpochMethod>>

function requireEpochRewards(adapter: SorobanAdapter): EpochAdapter {
  if (EPOCH_METHODS.some((name) => typeof adapter[name] !== 'function')) {
    throw new AppError(
      ErrorCode.NOT_IMPLEMENTED,
      501,
      'Epoch rewards is not available on the configured Soroban adapter',
    )
  }
  return adapter as EpochAdapter
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

function toEpochDto(epoch: EpochRewardsEpoch) {
  return {
    epochNumber: epoch.epochNumber,
    startTs: epoch.startTs,
    durationSecs: epoch.durationSecs,
    endTs: epoch.endTs,
    sealed: epoch.sealed,
    sealTs: epoch.sealTs,
    totalRewards: epoch.totalRewards.toString(),
    totalStakedAtSeal: epoch.totalStakedAtSeal.toString(),
    carriedForward: epoch.carriedForward.toString(),
  }
}

export function createEpochRewardsRouter(
  sorobanAdapter: SorobanAdapter,
  linkedAddressStore: LinkedAddressStore,
): Router {
  const router = Router()

  router.get(
    '/me',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const epochs = requireEpochRewards(sorobanAdapter)
        const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))
        const [currentEpoch, claimable, staked, totalStaked] = await Promise.all([
          epochs.epochRewardsCurrentEpoch(),
          epochs.epochRewardsGetClaimable(wallet),
          epochs.epochRewardsGetStake(wallet),
          epochs.epochRewardsTotalStaked(),
        ])
        const epoch = await epochs.epochRewardsGetEpoch(currentEpoch)

        res.json({
          success: true,
          data: {
            wallet,
            currentEpoch,
            // null when the deployed contract exposes no per-user stake getter
            staked: staked === null ? null : staked.toString(),
            claimable: claimable.toString(),
            totalStaked: totalStaked.toString(),
            epoch: epoch ? toEpochDto(epoch) : null,
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/epochs/:n',
    authenticateToken,
    validate(epochNumberParamsSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const epochs = requireEpochRewards(sorobanAdapter)
        const { n } = req.params as unknown as { n: number }
        const epoch = await epochs.epochRewardsGetEpoch(n)
        if (!epoch) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, `Epoch ${n} not found`)
        }
        res.json({ success: true, data: toEpochDto(epoch) })
      } catch (error) {
        next(error)
      }
    },
  )

  /** stake and unstake share one shape: prepare an unsigned call, then submit the signed one. */
  const amountCall = (call: Exclude<EpochRewardsCall, 'claim'>) => {
    router.post(
      `/${call}/prepare`,
      authenticateToken,
      validate(epochAmountSchema, 'body'),
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const epochs = requireEpochRewards(sorobanAdapter)
          const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))
          const amount = BigInt((req.body as { amount: string }).amount)

          if (call === 'unstake') {
            const staked = await epochs.epochRewardsGetStake(wallet)
            if (staked !== null && amount > staked) {
              throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Cannot unstake more than is staked')
            }
          }

          const xdr = await epochs.prepareEpochRewardsCall(call, wallet, amount)
          res.json({ success: true, data: { xdr } })
        } catch (error) {
          next(error)
        }
      },
    )

    router.post(
      `/${call}/submit`,
      authenticateToken,
      validate(epochSubmitAmountSchema, 'body'),
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const epochs = requireEpochRewards(sorobanAdapter)
          const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))
          const { signedXdr, amount } = req.body as { signedXdr: string; amount: string }

          const txHash = await epochs.submitEpochRewardsCall(signedXdr, call, wallet, BigInt(amount))
          res.json({ success: true, data: { txHash } })
        } catch (error) {
          next(error)
        }
      },
    )
  }
  amountCall('stake')
  amountCall('unstake')

  router.post(
    '/claim/prepare',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const epochs = requireEpochRewards(sorobanAdapter)
        const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))

        if ((await epochs.epochRewardsGetClaimable(wallet)) <= BigInt(0)) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Nothing to claim')
        }

        const xdr = await epochs.prepareEpochRewardsCall('claim', wallet)
        res.json({ success: true, data: { xdr } })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/claim/submit',
    authenticateToken,
    validate(epochSubmitClaimSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const epochs = requireEpochRewards(sorobanAdapter)
        const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))
        const { signedXdr } = req.body as { signedXdr: string }

        const txHash = await epochs.submitEpochRewardsCall(signedXdr, 'claim', wallet)
        res.json({ success: true, data: { txHash } })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}

export function createAdminEpochRewardsRouter(sorobanAdapter: SorobanAdapter): Router {
  const router = Router()

  router.post(
    '/fund',
    authenticateToken,
    requirePermission('rewards', 'manage'),
    validate(fundEpochSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const epochs = requireEpochRewards(sorobanAdapter)
        const amount = BigInt((req.body as { amount: string }).amount)

        const txHash = await epochs.epochRewardsFund(amount)
        const epoch = await epochs.epochRewardsCurrentEpoch()
        res.status(201).json({ success: true, data: { epoch, amount: amount.toString(), txHash } })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/seal',
    authenticateToken,
    requirePermission('rewards', 'manage'),
    validate(sealEpochSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        requireEpochRewards(sorobanAdapter)
        if (!supportsEpochSealing(sorobanAdapter)) {
          throw new AppError(ErrorCode.NOT_IMPLEMENTED, 501, 'Epoch sealing is not available')
        }
        const body = req.body as { targetEpoch?: number; nextEpochDurationSecs?: number }

        const outcome = await sealEpochIfDue(sorobanAdapter, body)
        if (outcome.status === 'not_due') {
          throw new AppError(
            ErrorCode.CONFLICT,
            409,
            `Epoch ${outcome.epoch} has not ended yet (ends at ${outcome.endsAt})`,
            { epoch: outcome.epoch, endsAt: outcome.endsAt },
          )
        }
        // Sealing twice is a no-op, so repeating the request is safe.
        res.status(outcome.status === 'sealed' ? 201 : 200).json({ success: true, data: outcome })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
