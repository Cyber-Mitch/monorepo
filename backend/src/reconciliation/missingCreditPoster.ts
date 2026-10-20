/**
 * PSP-backed missing-credit poster — #1950.
 *
 * A `missing_credit` mismatch means the ledger has a settlement that the PSP
 * never credited to the user, usually because the webhook was lost. This poster
 * re-verifies the payment with the PSP and credits the wallet only when all of
 * these hold:
 *   - the PSP reports the payment as confirmed;
 *   - the amount the PSP recorded matches the deposit;
 *   - a wallet deposit exists for the reference.
 *
 * It credits through the same steps as a confirmed webhook (routes/webhooks.ts):
 * the deposit is marked confirmed, then the wallet is credited. Re-running is
 * safe: `creditTopUp` is idempotent per deposit and per PSP reference.
 *
 * Staking deposits are not auto-credited here. A confirmed staking deposit also
 * triggers conversion and staking in the webhook, which needs the app's
 * conversion service, so those mismatches escalate to finance.
 */

import { logger } from '../utils/logger.js'
import { getPaymentProvider } from '../payments/registry.js'
import type { PaymentProvider } from '../payments/types.js'
import { ngnDepositStore } from '../models/ngnDepositStore.js'
import type { NgnWalletService } from '../services/ngnWalletService.js'
import { NonRetryableResolutionError, type MissingCreditPoster } from './resolver.js'

export interface MissingCreditPosterDeps {
  ngnWalletService: Pick<NgnWalletService, 'creditTopUp'>
  /** Injectable for tests; defaults to the configured PSP provider for the rail. */
  resolveProvider?: (rail: string) => PaymentProvider
}

export function createMissingCreditPoster(deps: MissingCreditPosterDeps): MissingCreditPoster {
  const resolveProvider = deps.resolveProvider ?? getPaymentProvider

  return async (mismatch) => {
    const rail = typeof mismatch.traceContext.rail === 'string' ? mismatch.traceContext.rail : ''
    const externalRef =
      typeof mismatch.traceContext.internalRef === 'string' ? mismatch.traceContext.internalRef : ''
    if (!rail || !externalRef) {
      throw new NonRetryableResolutionError('mismatch has no rail or payment reference')
    }

    const deposit = await ngnDepositStore.getByCanonical(rail, externalRef)
    if (!deposit) {
      throw new NonRetryableResolutionError(`no wallet deposit for ${rail}:${externalRef}`)
    }

    const verified = await resolveProvider(rail).verifyPayment({
      externalRefSource: rail,
      externalRef,
    })

    if (verified.status === 'failed' || verified.status === 'reversed') {
      throw new NonRetryableResolutionError(`PSP reports ${rail}:${externalRef} as ${verified.status}`)
    }
    if (verified.status !== 'confirmed') {
      // Still pending at the PSP. Leave the mismatch open so the next pass re-checks it.
      throw new Error(`PSP has not confirmed ${rail}:${externalRef} yet`)
    }
    if (verified.amountMinor === undefined) {
      throw new Error(`PSP did not report an amount for ${rail}:${externalRef}`)
    }
    if (verified.amountMinor !== Math.round(deposit.amountNgn * 100)) {
      throw new NonRetryableResolutionError(
        `PSP amount ${verified.amountMinor} (minor) differs from deposit ${deposit.depositId}`,
      )
    }

    await ngnDepositStore.setStatusByCanonical(rail, externalRef, 'confirmed')
    const credit = await deps.ngnWalletService.creditTopUp(
      deposit.userId,
      deposit.depositId,
      deposit.amountNgn,
      externalRef,
    )

    logger.info('[reconciliation] Missing credit posted from PSP confirmation', {
      depositId: deposit.depositId,
      rail,
      externalRef,
      credited: credit.credited,
    })
  }
}
