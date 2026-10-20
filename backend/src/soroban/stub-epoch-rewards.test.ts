import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StubEpochRewards } from './stub-epoch-rewards.js'

const EPOCH = 1000 // seconds
const T0 = 1_800_000_000

describe('StubEpochRewards (#1965)', () => {
  let book: StubEpochRewards

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(T0 * 1000))
    book = new StubEpochRewards(EPOCH)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const advance = (secs: number) => vi.setSystemTime(new Date((Date.now() / 1000 + secs) * 1000))

  it('opens epoch 1 with the configured duration', () => {
    expect(book.currentEpoch()).toBe(1)
    expect(book.getEpoch(1)).toMatchObject({
      epochNumber: 1,
      startTs: T0,
      durationSecs: EPOCH,
      endTs: T0 + EPOCH,
      sealed: false,
    })
    expect(book.getEpoch(2)).toBeNull()
  })

  it('tracks stakes and rejects unstaking more than is staked', () => {
    book.stake('alice', 100n)
    book.stake('alice', 50n)
    book.unstake('alice', 30n)

    expect(book.getStake('alice')).toBe(120n)
    expect(book.totalStaked()).toBe(120n)
    expect(() => book.unstake('alice', 1_000n)).toThrow(/more than is staked/)
    expect(() => book.stake('alice', 0n)).toThrow(/positive/)
  })

  it('refuses to seal before the epoch has ended', () => {
    advance(EPOCH - 1)

    expect(() => book.seal(1, EPOCH)).toThrow(/not ended/)
  })

  it('seals strictly in order and never twice', () => {
    advance(EPOCH)
    expect(() => book.seal(2, EPOCH)).toThrow(/in order/)

    book.seal(1, EPOCH)

    expect(book.currentEpoch()).toBe(2)
    expect(() => book.seal(1, EPOCH)).toThrow(/in order/)
  })

  it('freezes the pool and total staked at seal and opens the next epoch', () => {
    book.stake('alice', 100n)
    book.fund(1_000n)
    advance(EPOCH)
    book.seal(1, 500)
    book.stake('alice', 900n) // after sealing: must not change epoch 1

    expect(book.getEpoch(1)).toMatchObject({ sealed: true, totalRewards: 1_000n, totalStakedAtSeal: 100n })
    expect(book.getEpoch(2)).toMatchObject({ sealed: false, durationSecs: 500, totalRewards: 0n })
  })

  it('pays nothing for an unsealed epoch', () => {
    book.stake('alice', 100n)
    book.fund(1_000n)

    expect(book.claimable('alice')).toBe(0n)
  })

  it('pays pro-rata to the stake at seal, and the sum never exceeds the pool', () => {
    book.stake('alice', 1n)
    book.stake('bob', 2n)
    book.fund(100n)
    advance(EPOCH)
    book.seal(1, EPOCH)

    const alice = book.claimable('alice')
    const bob = book.claimable('bob')

    expect(alice).toBe(33n)
    expect(bob).toBe(66n)
    expect(alice + bob).toBeLessThanOrEqual(100n) // the 1 left over is rounding dust
  })

  it('makes claims idempotent', () => {
    book.stake('alice', 10n)
    book.fund(500n)
    advance(EPOCH)
    book.seal(1, EPOCH)

    expect(book.claim('alice')).toBe(500n)
    expect(book.claim('alice')).toBe(0n)
    expect(book.claimable('alice')).toBe(0n)
  })

  it('pays across several sealed epochs in one claim', () => {
    book.stake('alice', 10n)
    book.fund(100n)
    advance(EPOCH)
    book.seal(1, EPOCH)
    book.fund(40n)
    advance(EPOCH)
    book.seal(2, EPOCH)

    expect(book.claimable('alice')).toBe(140n)
  })

  it('rolls the pool of an epoch with no stakers into the next one', () => {
    book.fund(100n)
    advance(EPOCH)
    book.seal(1, EPOCH)
    book.stake('alice', 10n)
    advance(EPOCH)
    book.seal(2, EPOCH)

    expect(book.claim('alice')).toBe(100n)
  })
})
