/**
 * In-memory epoch_rewards contract for the stub adapter (#1965).
 *
 * Follows the contract's rules so the routes can be tested end to end: epochs
 * are sealed strictly in order and only once their duration has passed; sealing
 * freezes the pool and the total staked, and opens the next epoch; claims pay a
 * pro-rata share of every sealed, unclaimed epoch, once. The share is weighted
 * by each user's stake at seal time (the contract itself weights by time staked
 * within the epoch, which the stub does not model).
 */

import type { EpochRewardsEpoch } from './adapter.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'

interface StubEpoch extends EpochRewardsEpoch {
  /** Stake of every user when the epoch was sealed. */
  stakeAtSeal: Map<string, bigint>
}

const fail = (message: string, status = 400) => new AppError(ErrorCode.VALIDATION_ERROR, status, message)

const nowSecs = () => Math.floor(Date.now() / 1000)

export class StubEpochRewards {
  private epochs = new Map<number, StubEpoch>()
  private current = 1
  private stakes = new Map<string, bigint>()
  /** Last epoch each user has claimed through. */
  private claimedThrough = new Map<string, number>()

  /** Epoch 1 opens when the stub is created, standing in for the contract's `init`. */
  constructor(defaultEpochDurationSecs: number = 30 * 24 * 60 * 60) {
    this.epochs.set(1, this.openEpoch(1, nowSecs(), defaultEpochDurationSecs, 0n))
  }

  private openEpoch(epochNumber: number, startTs: number, durationSecs: number, carried: bigint): StubEpoch {
    return {
      epochNumber,
      startTs,
      durationSecs,
      endTs: startTs + durationSecs,
      sealed: false,
      sealTs: 0,
      totalRewards: 0n,
      totalStakedAtSeal: 0n,
      carriedForward: carried,
      stakeAtSeal: new Map(),
    }
  }

  currentEpoch(): number {
    return this.current
  }

  getEpoch(n: number): EpochRewardsEpoch | null {
    const epoch = this.epochs.get(n)
    if (!epoch) return null
    const { stakeAtSeal: _snapshot, ...info } = epoch
    return { ...info }
  }

  totalStaked(): bigint {
    let total = 0n
    for (const amount of this.stakes.values()) total += amount
    return total
  }

  getStake(user: string): bigint {
    return this.stakes.get(user) ?? 0n
  }

  stake(user: string, amount: bigint): void {
    if (amount <= 0n) throw fail('Amount must be positive')
    this.stakes.set(user, this.getStake(user) + amount)
  }

  unstake(user: string, amount: bigint): void {
    if (amount <= 0n) throw fail('Amount must be positive')
    const staked = this.getStake(user)
    if (amount > staked) throw fail('Cannot unstake more than is staked')
    this.stakes.set(user, staked - amount)
  }

  fund(amount: bigint): void {
    if (amount <= 0n) throw fail('Amount must be positive')
    const epoch = this.epochs.get(this.current)!
    epoch.totalRewards += amount
  }

  seal(targetEpoch: number, nextEpochDurationSecs: number): void {
    if (targetEpoch !== this.current) throw fail('Epochs must be sealed in order', 409)
    const epoch = this.epochs.get(targetEpoch)!
    if (epoch.sealed) throw fail('Epoch is already sealed', 409)
    const now = nowSecs()
    if (now < epoch.endTs) throw fail('Epoch has not ended yet', 409)
    if (nextEpochDurationSecs <= 0) throw fail('Next epoch duration must be positive')

    epoch.sealed = true
    epoch.sealTs = now
    epoch.totalStakedAtSeal = this.totalStaked()
    epoch.stakeAtSeal = new Map(this.stakes)

    // A sealed epoch with nobody staked pays nobody; its pool rolls into the next epoch.
    const carried = epoch.totalStakedAtSeal === 0n ? epoch.totalRewards + epoch.carriedForward : 0n
    this.current = targetEpoch + 1
    this.epochs.set(this.current, this.openEpoch(this.current, now, nextEpochDurationSecs, carried))
  }

  private shareOf(user: string, epoch: StubEpoch): bigint {
    if (epoch.totalStakedAtSeal === 0n) return 0n
    const staked = epoch.stakeAtSeal.get(user) ?? 0n
    // Integer division: rounding dust stays in the contract.
    return ((epoch.totalRewards + epoch.carriedForward) * staked) / epoch.totalStakedAtSeal
  }

  claimable(user: string): bigint {
    let total = 0n
    for (let n = (this.claimedThrough.get(user) ?? 0) + 1; n < this.current; n += 1) {
      total += this.shareOf(user, this.epochs.get(n)!)
    }
    return total
  }

  /** Pays out everything claimable and returns the amount; claiming again pays nothing. */
  claim(user: string): bigint {
    const amount = this.claimable(user)
    this.claimedThrough.set(user, this.current - 1)
    return amount
  }
}
