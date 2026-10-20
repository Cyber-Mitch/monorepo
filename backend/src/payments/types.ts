import type { Request } from 'express'

export type InternalPaymentStatus = 'pending' | 'confirmed' | 'failed' | 'reversed'

export interface InitiatePaymentInput {
  amountNgn: number
  userId: string
  internalRef: string
  rail: string
  customerMeta?: {
    name?: string
    phone?: string
    email?: string
  }
}

export interface InitiatePaymentResult {
  externalRefSource: string
  externalRef: string
  redirectUrl?: string
  bankDetails?: Record<string, string>
}

export interface ParseWebhookResult {
  externalRefSource: string
  externalRef: string
  rawStatus: string
  providerStatus?: string
  /**
   * Stable per-delivery id from the PSP (or a deterministic hash when the PSP omits one).
   * Used for deduping replays in addition to business-reference idempotency.
   */
  providerEventId: string
}

export interface MapStatusInput {
  rawStatus: string
  providerStatus?: string
}

export interface ExecutePayoutInput {
  amountNgn: number
  userId: string
  internalRef: string
  bankAccount: {
    accountNumber: string
    accountName: string
    bankName: string
  }
  rail: string
}

export interface ExecutePayoutResult {
  externalRefSource: string
  externalRef: string
  status: 'confirmed' | 'failed'
  providerStatus?: string
}

export interface VerifyPayoutResult {
  status: 'confirmed' | 'failed' | 'pending'
  providerStatus?: string
}

export interface PaymentProvider {
  readonly name: string

  initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult>

  /**
   * Looks a payment up at the PSP by our reference. `amountMinor` is the amount the
   * PSP recorded, in minor units (kobo), when it reports one; reconciliation uses
   * it to check a confirmed payment against the deposit before crediting.
   */
  verifyPayment(_input: { externalRefSource: string; externalRef: string }): Promise<{
    status: InternalPaymentStatus
    providerStatus?: string
    amountMinor?: number
  }>

  parseAndValidateWebhook(req: Request): Promise<ParseWebhookResult>

  mapStatus(input: MapStatusInput): InternalPaymentStatus

  executePayout?(input: ExecutePayoutInput): Promise<ExecutePayoutResult>

  /**
   * Asks the PSP what happened to a payout we already submitted, looked up by
   * our payout reference. Used for stuck payouts. Never resubmits a transfer.
   */
  verifyPayout?(input: { internalRef: string }): Promise<VerifyPayoutResult>

  resolveBankAccount?(accountNumber: string, bankCode: string): Promise<{
    accountName: string
    accountNumber: string
  }>
}
