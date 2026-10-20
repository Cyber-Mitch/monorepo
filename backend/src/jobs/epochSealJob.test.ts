import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import { EpochSealJob } from './epochSealJob.js'
import { sealEpochIfDue } from '../services/epochSealService.js'
import { StubSorobanAdapter } from '../soroban/stub-adapter.js'

const T0 = Math.floor(new Date('2026-10-19T00:00:00Z').getTime() / 1000)
const EPOCH_SECS = 300

describe('EpochSealJob (#1965)', () => {
  let adapter: StubSorobanAdapter
  const setNow = (secs: number) => vi.setSystemTime(new Date(secs * 1000))

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    setNow(T0)
    StubSorobanAdapter._testOnlyReset()
    StubSorobanAdapter._testOnlyConfigureEpochs(EPOCH_SECS)
    adapter = new StubSorobanAdapter({
      rpcUrl: 'http://localhost:8000',
      networkPassphrase: 'Test SDF Network ; September 2015',
      epochRewardsId: StrKey.encodeContract(Buffer.alloc(32, 5)),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does nothing while the epoch is still running', async () => {
    const job = new EpochSealJob(adapter)
    setNow(T0 + EPOCH_SECS - 1)

    expect(await job.poll()).toBe(false)
    expect(await adapter.epochRewardsCurrentEpoch()).toBe(1)
  })

  it('seals the epoch once it has ended', async () => {
    const job = new EpochSealJob(adapter)
    setNow(T0 + EPOCH_SECS)

    expect(await job.poll()).toBe(true)

    expect(await adapter.epochRewardsCurrentEpoch()).toBe(2)
    expect((await adapter.epochRewardsGetEpoch(1))?.sealed).toBe(true)
  })

  it('does not double seal when it runs again, or on another instance', async () => {
    const seal = vi.spyOn(adapter, 'epochRewardsSeal')
    const jobA = new EpochSealJob(adapter)
    const jobB = new EpochSealJob(adapter)
    setNow(T0 + EPOCH_SECS)

    expect(await jobA.poll()).toBe(true)
    expect(await jobA.poll()).toBe(false)
    expect(await jobB.poll()).toBe(false)

    expect(seal).toHaveBeenCalledTimes(1)
    expect(await adapter.epochRewardsCurrentEpoch()).toBe(2)
  })

  it('seals each following epoch in turn, never skipping one', async () => {
    const job = new EpochSealJob(adapter)

    setNow(T0 + EPOCH_SECS)
    await job.poll()
    setNow(T0 + 2 * EPOCH_SECS)
    await job.poll()
    // Late by several epochs: only the current one is due; the job catches up one per run.
    setNow(T0 + 10 * EPOCH_SECS)
    await job.poll()

    expect(await adapter.epochRewardsCurrentEpoch()).toBe(4)
    expect((await adapter.epochRewardsGetEpoch(3))?.sealed).toBe(true)
    expect((await adapter.epochRewardsGetEpoch(4))?.sealed).toBe(false)
  })

  it('treats a seal that lost a race as already sealed, not as a failure', async () => {
    setNow(T0 + EPOCH_SECS)
    const real = adapter.epochRewardsSeal.bind(adapter)
    vi.spyOn(adapter, 'epochRewardsSeal').mockImplementationOnce(async (epoch, next) => {
      await real(epoch, next) // another instance got there first
      throw new Error('Epoch is already sealed')
    })

    const outcome = await sealEpochIfDue(adapter as never)

    expect(outcome).toEqual({ status: 'already_sealed', epoch: 1 })
  })

  it('rethrows a real failure and leaves the epoch open for the next run', async () => {
    setNow(T0 + EPOCH_SECS)
    vi.spyOn(adapter, 'epochRewardsSeal').mockRejectedValueOnce(new Error('rpc down'))

    await expect(sealEpochIfDue(adapter as never)).rejects.toThrow('rpc down')
    expect(await adapter.epochRewardsCurrentEpoch()).toBe(1)

    const job = new EpochSealJob(adapter)
    expect(await job.poll()).toBe(true)
  })

  it('survives an adapter error without crashing the job', async () => {
    setNow(T0 + EPOCH_SECS)
    vi.spyOn(adapter, 'epochRewardsSeal').mockRejectedValue(new Error('rpc down'))
    const job = new EpochSealJob(adapter)

    await expect(job.poll()).resolves.toBe(false)
  })

  it('is a no-op for an adapter without epoch support', async () => {
    const job = new EpochSealJob({} as never)

    await expect(job.poll()).resolves.toBe(false)
  })

  it('stops its timer', async () => {
    const job = new EpochSealJob(adapter, 10)
    job.start()
    await job.stop()

    // a second stop is harmless
    await job.stop()
  })
})
