import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMissingCreditPoster } from './missingCreditPoster.js'
import { NonRetryableResolutionError } from './resolver.js'
import type { Mismatch } from './types.js'
import type { PaymentProvider } from '../payments/types.js'
import { ngnDepositStore } from '../models/ngnDepositStore.js'

vi.mock('../models/ngnDepositStore.js', () => ({
  ngnDepositStore: {
    getByCanonical: vi.fn(),
    setStatusByCanonical: vi.fn(),
  },
}))

const deposit = {
  depositId: 'dep-1',
  userId: 'user-1',
  amountNgn: 5000,
  rail: 'paystack',
  externalRefSource: 'paystack',
  externalRef: 'psk_ref_1',
  status: 'pending',
}

function mismatch(overrides: Partial<Mismatch> = {}): Mismatch {
  return {
    id: 'm-1',
    mismatchClass: 'missing_credit',
    toleranceMinor: 0n,
    status: 'open',
    resolutionAttempts: 0,
    traceContext: { rail: 'paystack', internalRef: 'psk_ref_1', ledgerEventId: 'le-1' },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function providerReturning(result: Awaited<ReturnType<PaymentProvider['verifyPayment']>>) {
  const verifyPayment = vi.fn(async () => result)
  const provider = { verifyPayment } as unknown as PaymentProvider
  return { provider, verifyPayment }
}

describe('createMissingCreditPoster', () => {
  let creditTopUp: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(ngnDepositStore.getByCanonical).mockResolvedValue(deposit as any)
    vi.mocked(ngnDepositStore.setStatusByCanonical).mockResolvedValue(deposit as any)
    creditTopUp = vi.fn(async () => ({ credited: true, newBalance: {} }))
  })

  it('credits the wallet once the PSP confirms the payment and the amount matches', async () => {
    const { provider, verifyPayment } = providerReturning({ status: 'confirmed', amountMinor: 500000 })
    const poster = createMissingCreditPoster({
      ngnWalletService: { creditTopUp } as any,
      resolveProvider: () => provider,
    })

    await poster(mismatch())

    expect(verifyPayment).toHaveBeenCalledWith({ externalRefSource: 'paystack', externalRef: 'psk_ref_1' })
    expect(ngnDepositStore.setStatusByCanonical).toHaveBeenCalledWith('paystack', 'psk_ref_1', 'confirmed')
    expect(creditTopUp).toHaveBeenCalledWith('user-1', 'dep-1', 5000, 'psk_ref_1')
  })

  it('does not credit when the PSP reports the payment failed', async () => {
    const { provider } = providerReturning({ status: 'failed', amountMinor: 500000 })
    const poster = createMissingCreditPoster({
      ngnWalletService: { creditTopUp } as any,
      resolveProvider: () => provider,
    })

    await expect(poster(mismatch())).rejects.toBeInstanceOf(NonRetryableResolutionError)
    expect(creditTopUp).not.toHaveBeenCalled()
    expect(ngnDepositStore.setStatusByCanonical).not.toHaveBeenCalled()
  })

  it('escalates without crediting when the PSP amount differs from the deposit', async () => {
    const { provider } = providerReturning({ status: 'confirmed', amountMinor: 100 })
    const poster = createMissingCreditPoster({
      ngnWalletService: { creditTopUp } as any,
      resolveProvider: () => provider,
    })

    await expect(poster(mismatch())).rejects.toBeInstanceOf(NonRetryableResolutionError)
    expect(creditTopUp).not.toHaveBeenCalled()
  })

  it('leaves the mismatch retryable while the PSP has not confirmed the payment', async () => {
    const { provider } = providerReturning({ status: 'pending' })
    const poster = createMissingCreditPoster({
      ngnWalletService: { creditTopUp } as any,
      resolveProvider: () => provider,
    })

    const attempt = poster(mismatch())
    await expect(attempt).rejects.toThrow('has not confirmed')
    await expect(attempt).rejects.not.toBeInstanceOf(NonRetryableResolutionError)
    expect(creditTopUp).not.toHaveBeenCalled()
  })

  it('does not double-credit when the poster runs again for the same reference', async () => {
    const { provider } = providerReturning({ status: 'confirmed', amountMinor: 500000 })
    creditTopUp
      .mockResolvedValueOnce({ credited: true, newBalance: {} })
      .mockResolvedValueOnce({ credited: false, newBalance: {} })
    const poster = createMissingCreditPoster({
      ngnWalletService: { creditTopUp } as any,
      resolveProvider: () => provider,
    })

    await poster(mismatch())
    await expect(poster(mismatch())).resolves.toBeUndefined()

    expect(creditTopUp).toHaveBeenCalledTimes(2)
    expect(await creditTopUp.mock.results[1]!.value).toMatchObject({ credited: false })
  })

  it('escalates when no wallet deposit matches the reference', async () => {
    vi.mocked(ngnDepositStore.getByCanonical).mockResolvedValue(null)
    const poster = createMissingCreditPoster({
      ngnWalletService: { creditTopUp } as any,
      resolveProvider: () => providerReturning({ status: 'confirmed', amountMinor: 500000 }).provider,
    })

    await expect(poster(mismatch())).rejects.toBeInstanceOf(NonRetryableResolutionError)
    expect(creditTopUp).not.toHaveBeenCalled()
  })
})
