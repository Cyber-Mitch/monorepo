/**
 * Pre-conditions for account erasure (issue #1900).
 *
 * - Eligibility: a user cannot be erased while they still have an active deal
 *   (as tenant or landlord) or a non-zero NGN wallet balance. Both checks are
 *   injectable so route tests can control them.
 * - Re-authentication: Shelterflex has no passwords (email OTP or Stellar
 *   wallet-signature login only), so "re-confirm your credentials" means
 *   presenting a FRESH proof of the same kind used to log in: an email OTP
 *   from POST /auth/request-otp, or a signed challenge from
 *   POST /auth/wallet/challenge for wallet-only accounts.
 */

import { dealStore } from '../models/dealStore.js'
import { DealStatus } from '../models/deal.js'
import { ngnWalletStore } from '../models/ngnWalletStore.js'
import { otpChallengeStore, walletChallengeStore } from '../models/authStore.js'
import { verifyOtpHash } from '../utils/otp.js'
import { normalizeStellarAddress, verifySignedChallenge } from '../utils/wallet.js'
import type { NgnWalletService } from './ngnWalletService.js'

// Mirror the limits enforced by POST /auth/verify-otp and /auth/wallet/verify.
const OTP_MAX_ATTEMPTS = 5
const WALLET_MAX_ATTEMPTS = 3

const ACTIVE_DEAL_STATUSES: DealStatus[] = [DealStatus.ACTIVE, DealStatus.AT_RISK]

export interface ErasureEligibilityChecks {
  /** Number of active / at-risk deals the user is a party to (tenant or landlord). */
  countActiveDeals(userId: string): Promise<number>
  /** Total (available + held) NGN wallet balance; 0 when the user has no wallet. */
  getWalletBalanceNgn(userId: string): Promise<number>
}

export interface ErasureBlocker {
  type: 'active_deal' | 'wallet_balance'
  message: string
  count?: number
  balanceNgn?: number
}

export function createDefaultErasureEligibilityChecks(
  ngnWalletService?: Pick<NgnWalletService, 'getBalance'>,
): ErasureEligibilityChecks {
  return {
    async countActiveDeals(userId) {
      let total = 0
      for (const status of ACTIVE_DEAL_STATUSES) {
        const asTenant = await dealStore.findMany({ tenantId: userId, status, pageSize: 1 })
        const asLandlord = await dealStore.findMany({ landlordId: userId, status, pageSize: 1 })
        total += asTenant.total + asLandlord.total
      }
      return total
    },
    async getWalletBalanceNgn(userId) {
      // Look the wallet up first: NgnWalletService.getBalance lazily creates a
      // (demo-funded) wallet, which must not happen as a side effect of a check.
      const wallet = await ngnWalletStore.getWalletByUserId(userId)
      if (!wallet || !ngnWalletService) return 0
      const balance = await ngnWalletService.getBalance(userId)
      return balance.totalNgn
    },
  }
}

export async function findErasureBlockers(
  userId: string,
  checks: ErasureEligibilityChecks,
): Promise<ErasureBlocker[]> {
  const blockers: ErasureBlocker[] = []

  const activeDeals = await checks.countActiveDeals(userId)
  if (activeDeals > 0) {
    blockers.push({
      type: 'active_deal',
      count: activeDeals,
      message: `Complete or close ${activeDeals} active deal(s) before requesting erasure`,
    })
  }

  const balanceNgn = await checks.getWalletBalanceNgn(userId)
  if (balanceNgn !== 0) {
    blockers.push({
      type: 'wallet_balance',
      balanceNgn,
      message: `Withdraw or settle the NGN wallet balance (₦${balanceNgn.toFixed(2)}) before requesting erasure`,
    })
  }

  return blockers
}

export interface ErasureReauthInput {
  otp?: string
  signedChallengeXdr?: string
}

/**
 * Verify (and consume) a fresh login proof for the authenticated user.
 * Returns false for missing, expired, exhausted or wrong proofs.
 */
export async function verifyErasureReauth(
  user: { email: string; walletAddress?: string },
  input: ErasureReauthInput,
): Promise<boolean> {
  if (input.otp) {
    const email = user.email.toLowerCase()
    const challenge = await otpChallengeStore.getByEmail(email)
    if (!challenge) return false
    if (new Date() > challenge.expiresAt || challenge.attempts >= OTP_MAX_ATTEMPTS) {
      await otpChallengeStore.deleteByEmail(email)
      return false
    }
    if (!verifyOtpHash(input.otp, challenge.salt, challenge.otpHash)) {
      await otpChallengeStore.updateAttempts(email, challenge.attempts + 1)
      return false
    }
    await otpChallengeStore.deleteByEmail(email)
    return true
  }

  if (input.signedChallengeXdr) {
    if (!user.walletAddress) return false
    let address: string
    try {
      address = normalizeStellarAddress(user.walletAddress)
    } catch {
      return false
    }
    const challenge = await walletChallengeStore.getByAddress(address)
    if (!challenge) return false
    if (new Date() > challenge.expiresAt || challenge.attempts >= WALLET_MAX_ATTEMPTS) {
      await walletChallengeStore.deleteByAddress(address)
      return false
    }
    if (!verifySignedChallenge(address, input.signedChallengeXdr, challenge.nonce)) {
      await walletChallengeStore.updateAttempts(address, challenge.attempts + 1)
      return false
    }
    await walletChallengeStore.deleteByAddress(address)
    return true
  }

  return false
}
