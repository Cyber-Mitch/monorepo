import type { NgnWalletService } from '../services/ngnWalletService.js'
import { getPaymentProvider } from '../payments/index.js'
import type { PaymentProvider } from '../payments/types.js'
import { logger } from '../utils/logger.js'
import { observeJobRun } from './jobObservability.js'

const PAYOUT_REFERENCE_PREFIX = 'payout-'

/**
 * Deterministic PSP reference for a withdrawal. The same withdrawal always maps
 * to the same reference, so a PSP can deduplicate and a status lookup can find it.
 */
export function payoutReferenceFor(withdrawalId: string): string {
  return `${PAYOUT_REFERENCE_PREFIX}${withdrawalId}`
}

/** Inverse of payoutReferenceFor. Returns null for references we did not issue. */
export function withdrawalIdFromPayoutReference(reference: string): string | null {
  if (!reference.startsWith(PAYOUT_REFERENCE_PREFIX)) return null
  const id = reference.slice(PAYOUT_REFERENCE_PREFIX.length)
  return id.length > 0 ? id : null
}

export interface WithdrawalPayoutWorkerOptions {
  pollIntervalMs?: number
  /** Processing for longer than this is treated as stuck and checked with the PSP. */
  stuckAfterMs?: number
  /** Rail used to pick the PSP (PSP_PROVIDER_{RAIL} selects the implementation). */
  rail?: string
  batchSize?: number
  resolveProvider?: (rail: string) => PaymentProvider
  /** Called after a payout fails, so the user can be told. Errors are logged, not thrown. */
  notifyFailure?: (userId: string, withdrawalId: string, reason: string) => Promise<void>
}

/**
 * Sends approved NGN withdrawals to the PSP.
 *
 * Each withdrawal is claimed (approved -> processing) before the PSP call, so
 * it is sent at most once. If the call throws, the withdrawal stays in
 * 'processing' and is never resubmitted. The stuck-payout sweep asks the PSP
 * what happened instead.
 */
export class WithdrawalPayoutWorker {
  private interval: NodeJS.Timeout | null = null
  private processingPromise: Promise<void> | null = null
  private readonly pollIntervalMs: number
  private readonly stuckAfterMs: number
  private readonly rail: string
  private readonly batchSize: number
  private readonly resolveProvider: (rail: string) => PaymentProvider
  private readonly notifyFailure?: WithdrawalPayoutWorkerOptions['notifyFailure']

  constructor(
    private readonly walletService: NgnWalletService,
    options: WithdrawalPayoutWorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000
    this.stuckAfterMs = options.stuckAfterMs ?? 15 * 60 * 1000
    this.rail = options.rail ?? process.env.WITHDRAWAL_PAYOUT_RAIL ?? 'psp'
    this.batchSize = options.batchSize ?? 50
    this.resolveProvider = options.resolveProvider ?? getPaymentProvider
    this.notifyFailure = options.notifyFailure
  }

  start() {
    if (this.interval) return
    logger.info('Starting WithdrawalPayoutWorker job', { pollIntervalMs: this.pollIntervalMs })
    this.interval = setInterval(() => {
      this.processingPromise = this.poll().finally(() => {
        this.processingPromise = null
      })
    }, this.pollIntervalMs)
  }

  async stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    if (this.processingPromise) {
      logger.info('WithdrawalPayoutWorker waiting for in-progress task to complete...')
      await this.processingPromise
    }
    logger.info('Stopped WithdrawalPayoutWorker job')
  }

  async poll() {
    await observeJobRun('withdrawal-payout', async () => {
      const submitted = await this.submitApproved()
      const recovered = await this.recoverStuck()
      return { recordsProcessed: submitted + recovered }
    })
  }

  /** Sends each approved withdrawal to the PSP once. Returns how many were attempted. */
  async submitApproved(): Promise<number> {
    const provider = this.resolveProvider(this.rail)
    const executePayout = provider.executePayout?.bind(provider)
    if (!executePayout) {
      if ((await this.walletService.listWithdrawalsByStatus('approved')).length > 0) {
        logger.warn('Approved withdrawals waiting: PSP provider has no executePayout', {
          provider: provider.name,
        })
      }
      return 0
    }

    let attempted = 0
    for (const withdrawal of (await this.walletService.listWithdrawalsByStatus('approved', this.batchSize)).slice(0, this.batchSize)) {
      const claimed = await this.walletService.claimForPayout(withdrawal.id)
      if (!claimed) continue
      attempted += 1

      const userId = (await this.walletService.getWithdrawalUserId(withdrawal.id))!
      try {
        const result = await executePayout({
          amountNgn: withdrawal.amountNgn,
          userId,
          internalRef: payoutReferenceFor(withdrawal.id),
          bankAccount: withdrawal.bankAccount,
          rail: this.rail,
        })

        if (result.status === 'confirmed') {
          await this.walletService.completePayout(withdrawal.id)
        } else {
          const reason = result.providerStatus ?? 'Transfer rejected by provider'
          await this.walletService.failPayout(withdrawal.id, reason)
          await this.notify(userId, withdrawal.id, reason)
        }
      } catch (error) {
        // Unknown outcome: the transfer may have reached the PSP. Leave the
        // withdrawal in 'processing' for the status sweep. Do not resubmit.
        logger.error('Payout submission failed; withdrawal left for status check', {
          withdrawalId: withdrawal.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return attempted
  }

  /** Checks payouts stuck in 'processing' with the PSP. Never resubmits. */
  async recoverStuck(): Promise<number> {
    const stuck: Awaited<ReturnType<typeof this.walletService.listWithdrawalsByStatus>> = []
    for (const w of await this.walletService.listWithdrawalsByStatus('processing')) {
      const startedAt = (await this.walletService.getPayoutStartedAt(w.id)) ?? 0
      if (Date.now() - startedAt >= this.stuckAfterMs) stuck.push(w)
    }
    if (stuck.length === 0) return 0

    const provider = this.resolveProvider(this.rail)
    const verifyPayout = provider.verifyPayout?.bind(provider)
    if (!verifyPayout) {
      logger.warn('Stuck payouts need manual review: PSP provider has no verifyPayout', {
        provider: provider.name,
        count: stuck.length,
      })
      return 0
    }

    let checked = 0
    for (const withdrawal of stuck) {
      try {
        const status = await verifyPayout({ internalRef: payoutReferenceFor(withdrawal.id) })
        checked += 1
        if (status.status === 'confirmed') {
          await this.walletService.completePayout(withdrawal.id)
        } else if (status.status === 'failed') {
          const reason = status.providerStatus ?? 'Transfer failed at provider'
          await this.walletService.failPayout(withdrawal.id, reason)
          await this.notify((await this.walletService.getWithdrawalUserId(withdrawal.id))!, withdrawal.id, reason)
        } else {
          logger.warn('Stuck payout still pending at provider', { withdrawalId: withdrawal.id })
        }
      } catch (error) {
        logger.error('Stuck payout status check failed', {
          withdrawalId: withdrawal.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return checked
  }

  private async notify(userId: string, withdrawalId: string, reason: string) {
    if (!this.notifyFailure) return
    try {
      await this.notifyFailure(userId, withdrawalId, reason)
    } catch (error) {
      logger.warn('Failed to notify user about failed withdrawal', {
        withdrawalId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
