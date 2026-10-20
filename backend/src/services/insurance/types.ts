/**
 * Rent guarantee insurance provider abstraction (#1908).
 *
 * A provider prices a policy (quote), activates it (bind), terminates it
 * (cancel) and submits claims (fileClaim). Real insurer integrations plug in
 * behind this interface; none are implemented yet.
 */

export interface RentGuaranteeQuoteRequest {
  dealId: string
  landlordId: string
  annualRentNgn: number
  termMonths: number
  /** 1-based count of policies ever quoted for this deal, so each quote gets a distinct policy number. */
  sequence: number
}

export interface RentGuaranteeQuote {
  policyNumber: string
  premiumNgn: number
  coverageTermMonths: number
}

export interface RentGuaranteePolicyRef {
  policyNumber: string
  dealId: string
  landlordId: string
}

export interface RentGuaranteeBindResult {
  providerReference: string
}

export interface RentGuaranteeClaimRequest {
  amountNgn: number
  reason: string
}

export interface RentGuaranteeClaimResult {
  providerReference: string
}

export interface RentGuaranteeProvider {
  readonly name: string
  quote(request: RentGuaranteeQuoteRequest): Promise<RentGuaranteeQuote>
  bind(policy: RentGuaranteePolicyRef): Promise<RentGuaranteeBindResult>
  cancel(policy: RentGuaranteePolicyRef, reason?: string): Promise<void>
  fileClaim(
    policy: RentGuaranteePolicyRef,
    claim: RentGuaranteeClaimRequest,
  ): Promise<RentGuaranteeClaimResult>
}
