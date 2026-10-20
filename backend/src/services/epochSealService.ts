/**
 * Seals the current epoch_rewards epoch once it has ended (#1965).
 *
 * Used by both the scheduled job and the admin endpoint. It is idempotent: an
 * epoch that is not yet due is left alone, and an epoch that was already sealed
 * (by an earlier run, another instance or the admin) is reported rather than
 * sealed twice. The contract enforces the same rules, so a race between two
 * callers can at worst produce one rejected transaction, never a double seal.
 */

import type { SorobanAdapter } from '../soroban/adapter.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { logger } from '../utils/logger.js'

export type SealOutcome =
  | { status: 'sealed'; epoch: number; txHash: string }
  | { status: 'not_due'; epoch: number; endsAt: number }
  | { status: 'already_sealed'; epoch: number }

type EpochAdapter = SorobanAdapter &
  Required<Pick<SorobanAdapter, 'epochRewardsCurrentEpoch' | 'epochRewardsGetEpoch' | 'epochRewardsSeal'>>

export function supportsEpochSealing(adapter: SorobanAdapter): adapter is EpochAdapter {
  return (
    typeof adapter.epochRewardsCurrentEpoch === 'function' &&
    typeof adapter.epochRewardsGetEpoch === 'function' &&
    typeof adapter.epochRewardsSeal === 'function'
  )
}

export interface SealOptions {
  /** Epoch to seal; defaults to the current one. Anything but the current epoch is "already sealed" or an error. */
  targetEpoch?: number
  /** Length of the next epoch; defaults to the length of the one being sealed. */
  nextEpochDurationSecs?: number
  /** Unix seconds; injectable for tests. */
  now?: number
}

export async function sealEpochIfDue(
  adapter: EpochAdapter,
  options: SealOptions = {},
): Promise<SealOutcome> {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const current = await adapter.epochRewardsCurrentEpoch()
  const target = options.targetEpoch ?? current

  // Epochs are sealed strictly in order, so anything before the current epoch is already done.
  if (target < current) return { status: 'already_sealed', epoch: target }

  if (target > current) {
    throw new AppError(
      ErrorCode.CONFLICT,
      409,
      `Epoch ${target} cannot be sealed before epoch ${current}: epochs are sealed in order`,
    )
  }
  const info = await adapter.epochRewardsGetEpoch(target)
  if (!info) {
    throw new AppError(ErrorCode.NOT_FOUND, 404, `Epoch ${target} does not exist`)
  }
  if (info.sealed) return { status: 'already_sealed', epoch: target }
  if (now < info.endTs) return { status: 'not_due', epoch: target, endsAt: info.endTs }

  try {
    const txHash = await adapter.epochRewardsSeal(target, options.nextEpochDurationSecs ?? info.durationSecs)
    logger.info('Epoch sealed', { epoch: target, txHash })
    return { status: 'sealed', epoch: target, txHash }
  } catch (error) {
    // Another caller may have sealed it between our read and our write.
    const after = await adapter.epochRewardsCurrentEpoch().catch(() => target)
    if (after > target) {
      logger.info('Epoch was sealed concurrently', { epoch: target })
      return { status: 'already_sealed', epoch: target }
    }
    throw error
  }
}
