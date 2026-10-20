/**
 * Lease Agreement model and types
 */

export enum LeaseStatus {
  DRAFT = 'draft',
  PENDING_TENANT_SIGNATURE = 'pending_tenant_signature',
  PENDING_LANDLORD_SIGNATURE = 'pending_landlord_signature',
  FULLY_SIGNED = 'fully_signed',
  VOIDED = 'voided',
}

export interface LeaseAgreement {
  leaseId: string
  dealId: string
  documentKey: string
  /**
   * Hash of the document bytes recorded when the lease was generated. The
   * integrity endpoint re-hashes the stored document and compares it with this
   * value to prove the document has not changed since it was generated (#1960).
   */
  documentHash?: string
  /** Version of the lease template the document was rendered from (#1954). */
  templateVersion?: string
  status: LeaseStatus
  tenantSignedAt?: Date
  landlordSignedAt?: Date
  tenantSignatureRef?: string
  landlordSignatureRef?: string
  createdAt: Date
  updatedAt: Date
}

export interface CreateLeaseInput {
  dealId: string
  documentKey: string
  documentHash?: string
  templateVersion?: string
}

/** A recorded signature event for a lease (one per party). */
export interface LeaseSignature {
  signatureId: string
  dealId: string
  leaseId: string
  signerId: string
  signerRole: 'tenant' | 'landlord'
  signerName: string
  signedAt: Date
  /** Client-supplied signature date (yyyy-MM-dd), stored verbatim. */
  signDate: string
  /** Document hash at the moment of signing. */
  documentHash: string
  ip?: string
  userAgent?: string
}

export interface CreateLeaseSignatureInput {
  dealId: string
  leaseId: string
  signerId: string
  signerRole: 'tenant' | 'landlord'
  signerName: string
  signDate: string
  documentHash: string
  ip?: string
  userAgent?: string
}
