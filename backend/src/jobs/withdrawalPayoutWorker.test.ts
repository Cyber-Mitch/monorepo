import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NgnWalletService } from '../services/ngnWalletService.js'
import { ngnWalletStore } from '../models/ngnWalletStore.js'
import { userRiskStateStore } from '../models/userRiskStateStore.js'
import { seedNgnWalletFixture } from '../test-fixtures/ngnWalletFixtures.js'
import type { PaymentProvider } from '../payments/types.js'
import { ngnWithdrawalStore } from '../models/ngnWithdrawalStore.js'
import {
  WithdrawalPayoutWorker,
  payoutReferenceFor,
  withdrawalIdFromPayoutReference,
} from './withdrawalPayoutWorker.js'

const userId = 'payout-user-1'
const bankAccount = { accountNumber: '1234567890', accountName: 'Test User', bankName: 'Test Bank' }

function fakeProvider(overrides: Partial<Record<'executePayout' | 'verifyPayout', unknown>> = {}) {
  const executePayout = vi.fn(
    overrides.executePayout ??
      (async () => ({ externalRefSource: 'psp', externalRef: 'po_1', status: 'confirmed' as const })),
  )
  const verifyPayout = vi.fn(
    overrides.verifyPayout ?? (async () => ({ status: 'confirmed' as const })),
  )
  const provider = { name: 'fake', executePayout, verifyPayout } as unknown as PaymentProvider
  return { provider, executePayout, verifyPayout }
}

describe('payout references', () => {
  it('derives a deterministic reference from the withdrawal id and round-trips it', () => {
    expect(payoutReferenceFor('wd-123')).toBe('payout-wd-123')
    expect(withdrawalIdFromPayoutReference('payout-wd-123')).toBe('wd-123')
  })

  it('returns null for references we did not issue', () => {
    expect(withdrawalIdFromPayoutReference('pi_something')).toBeNull()
    expect(withdrawalIdFromPayoutReference('payout-')).toBeNull()
  })
})

describe('WithdrawalPayoutWorker', () => {
  let service: NgnWalletService

  beforeEach(async () => {
    await ngnWithdrawalStore.clear()
    service = new NgnWalletService()
    await ngnWalletStore.clear()
    userRiskStateStore.clear()
    await seedNgnWalletFixture(userId)
  })

  async function approvedWithdrawal(amountNgn = 2000) {
    const withdrawal = await service.initiateWithdrawal(userId, { amountNgn, bankAccount })
    return service.approveWithdrawal(withdrawal.id)
  }

  function worker(provider: PaymentProvider, extra: Partial<ConstructorParameters<typeof WithdrawalPayoutWorker>[1]> = {}) {
    return new WithdrawalPayoutWorker(service, {
      resolveProvider: () => provider,
      stuckAfterMs: 15 * 60 * 1000,
      ...extra,
    })
  }

  it('happy path: pays the approved withdrawal once and confirms it', async () => {
    const withdrawal = await approvedWithdrawal(2000)
    const { provider, executePayout } = fakeProvider()

    await worker(provider).poll()

    expect(executePayout).toHaveBeenCalledTimes(1)
    expect(executePayout).toHaveBeenCalledWith(
      expect.objectContaining({
        amountNgn: 2000,
        userId,
        internalRef: payoutReferenceFor(withdrawal.id),
        bankAccount,
      }),
    )
    const settled = (await service.getWithdrawal(withdrawal.id))
    expect(settled?.status).toBe('confirmed')
    expect(settled?.processedAt).toBeTruthy()

    // Held funds leave the wallet once the transfer is confirmed
    const balance = await service.getBalance(userId)
    expect(balance.availableNgn).toBe(48000)
    expect(balance.heldNgn).toBe(5000)
  })

  it('PSP rejection fails the withdrawal and releases the held balance', async () => {
    const withdrawal = await approvedWithdrawal(2000)
    const notifyFailure = vi.fn(async () => {})
    const { provider } = fakeProvider({
      executePayout: async () => ({
        externalRefSource: 'psp',
        externalRef: 'po_2',
        status: 'failed' as const,
        providerStatus: 'insufficient_funds',
      }),
    })

    await worker(provider, { notifyFailure }).poll()

    const failed = (await service.getWithdrawal(withdrawal.id))
    expect(failed?.status).toBe('failed')
    expect(failed?.failureReason).toBe('insufficient_funds')

    const balance = await service.getBalance(userId)
    expect(balance.availableNgn).toBe(50000)
    expect(balance.heldNgn).toBe(5000)

    expect(notifyFailure).toHaveBeenCalledWith(userId, withdrawal.id, 'insufficient_funds')
  })

  it('never submits the same withdrawal to the PSP twice', async () => {
    await approvedWithdrawal(2000)
    const { provider, executePayout } = fakeProvider()
    const w = worker(provider)

    await w.poll()
    await w.poll()
    await w.poll()

    expect(executePayout).toHaveBeenCalledTimes(1)
  })

  it('a crash between the PSP call and the result leaves the withdrawal processing, not resubmitted', async () => {
    const withdrawal = await approvedWithdrawal(2000)
    const { provider, executePayout, verifyPayout } = fakeProvider({
      executePayout: async () => {
        throw new Error('socket hang up')
      },
    })
    // Long threshold, so the stuck sweep does not run in this test
    const w = worker(provider, { stuckAfterMs: 60 * 60 * 1000 })

    await w.poll()
    await w.poll()

    expect((await service.getWithdrawal(withdrawal.id))?.status).toBe('processing')
    expect(executePayout).toHaveBeenCalledTimes(1)
    expect(verifyPayout).not.toHaveBeenCalled()
    // Held funds stay held while the outcome is unknown
    expect((await service.getBalance(userId)).heldNgn).toBe(7000)
  })

  it('stuck payout is settled from the PSP status lookup, never resubmitted', async () => {
    const withdrawal = await approvedWithdrawal(2000)
    const { provider, executePayout, verifyPayout } = fakeProvider({
      executePayout: async () => {
        throw new Error('timeout')
      },
      verifyPayout: async () => ({ status: 'failed' as const, providerStatus: 'reversed' }),
    })
    // Zero threshold: the sweep treats every processing payout as stuck
    const w = worker(provider, { stuckAfterMs: 0 })

    await w.poll()

    expect(executePayout).toHaveBeenCalledTimes(1)
    expect(verifyPayout).toHaveBeenCalledWith({ internalRef: payoutReferenceFor(withdrawal.id) })
    expect((await service.getWithdrawal(withdrawal.id))?.status).toBe('failed')
    expect((await service.getBalance(userId)).availableNgn).toBe(50000)
  })

  it('leaves a stuck payout alone when the PSP still reports it pending', async () => {
    const withdrawal = await approvedWithdrawal(2000)
    const { provider } = fakeProvider({
      executePayout: async () => {
        throw new Error('timeout')
      },
      verifyPayout: async () => ({ status: 'pending' as const }),
    })

    await worker(provider, { stuckAfterMs: 0 }).poll()

    expect((await service.getWithdrawal(withdrawal.id))?.status).toBe('processing')
  })

  it('does nothing when the provider has no executePayout', async () => {
    await approvedWithdrawal(2000)
    const provider = { name: 'manual' } as unknown as PaymentProvider

    const attempted = await worker(provider).submitApproved()

    expect(attempted).toBe(0)
  })
})

describe('NgnWalletService payout settlement (idempotency)', () => {
  let service: NgnWalletService

  beforeEach(async () => {
    await ngnWithdrawalStore.clear()
    service = new NgnWalletService()
    await ngnWalletStore.clear()
    userRiskStateStore.clear()
    await seedNgnWalletFixture(userId)
  })

  it('a duplicate confirmation webhook does not write a second WITHDRAWAL_CONFIRMED entry', async () => {
    const withdrawal = await service.initiateWithdrawal(userId, { amountNgn: 2000, bankAccount })
    await service.approveWithdrawal(withdrawal.id)
    await service.claimForPayout(withdrawal.id)
    await service.completePayout(withdrawal.id)
    await service.completePayout(withdrawal.id)

    const ledger = await service.getLedger(userId, { limit: 100 })
    const confirmations = ledger.entries.filter((e) => e.type === 'WITHDRAWAL_CONFIRMED')
    expect(confirmations).toHaveLength(1)
    expect((await service.getBalance(userId)).heldNgn).toBe(5000)
  })

  it('a duplicate failure webhook does not release the balance twice', async () => {
    const withdrawal = await service.initiateWithdrawal(userId, { amountNgn: 2000, bankAccount })
    await service.approveWithdrawal(withdrawal.id)
    await service.claimForPayout(withdrawal.id)
    await service.failPayout(withdrawal.id, 'rejected')
    await service.failPayout(withdrawal.id, 'rejected')

    const ledger = await service.getLedger(userId, { limit: 100 })
    const releases = ledger.entries.filter((e) => e.type === 'WITHDRAWAL_FAILED')
    expect(releases).toHaveLength(1)
    expect((await service.getBalance(userId)).availableNgn).toBe(50000)
  })

  it('claimForPayout succeeds once per approved withdrawal', async () => {
    const withdrawal = await service.initiateWithdrawal(userId, { amountNgn: 2000, bankAccount })
    await service.approveWithdrawal(withdrawal.id)

    expect((await service.claimForPayout(withdrawal.id))?.status).toBe('processing')
    expect((await service.claimForPayout(withdrawal.id))).toBeNull()
  })

  it('a pending (not yet approved) withdrawal cannot be claimed for payout', async () => {
    const withdrawal = await service.initiateWithdrawal(userId, { amountNgn: 2000, bankAccount })

    expect((await service.claimForPayout(withdrawal.id))).toBeNull()
  })
})
