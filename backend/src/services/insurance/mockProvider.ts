import { createHash } from 'node:crypto'
import type {
  RentGuaranteeBindResult,
  RentGuaranteeClaimRequest,
  RentGuaranteeClaimResult,
  RentGuaranteePolicyRef,
  RentGuaranteeProvider,
  RentGuaranteeQuote,
  RentGuaranteeQuoteRequest,
} from './types.js'

/** Premium is 2.5% of annual rent, pro-rated by coverage term. */
export const MOCK_PREMIUM_RATE = 0.025

function digest(...parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 12).toUpperCase()
}

/**
 * Deterministic provider for development and tests: the same input always
 * yields the same output, and nothing leaves the process.
 */
export class MockRentGuaranteeProvider implements RentGuaranteeProvider {
  readonly name = 'mock'

  async quote(request: RentGuaranteeQuoteRequest): Promise<RentGuaranteeQuote> {
    const premium = request.annualRentNgn * MOCK_PREMIUM_RATE * (request.termMonths / 12)
    return {
      policyNumber: `MOCK-RG-${digest(request.dealId, request.landlordId, request.annualRentNgn, request.termMonths, request.sequence)}`,
      premiumNgn: Math.round(premium * 100) / 100,
      coverageTermMonths: request.termMonths,
    }
  }

  async bind(policy: RentGuaranteePolicyRef): Promise<RentGuaranteeBindResult> {
    return { providerReference: `MOCK-BIND-${digest(policy.policyNumber)}` }
  }

  async cancel(_policy: RentGuaranteePolicyRef, _reason?: string): Promise<void> {
    // Nothing to tear down.
  }

  async fileClaim(
    policy: RentGuaranteePolicyRef,
    claim: RentGuaranteeClaimRequest,
  ): Promise<RentGuaranteeClaimResult> {
    return { providerReference: `MOCK-CLAIM-${digest(policy.policyNumber, claim.amountNgn, claim.reason)}` }
  }
}
