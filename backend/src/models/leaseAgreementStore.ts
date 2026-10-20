/**
 * Lease Agreement store following the Hybrid pattern
 */

import { randomUUID } from 'node:crypto'
import { getPool, type PgPoolLike } from '../db.js'
import { LeaseAgreement, LeaseStatus, CreateLeaseInput } from './leaseAgreement.js'

interface LeaseAgreementStorePort {
  create(input: CreateLeaseInput): Promise<LeaseAgreement>
  getById(leaseId: string): Promise<LeaseAgreement | null>
  getByDealId(dealId: string): Promise<LeaseAgreement | null>
  updateStatus(leaseId: string, status: LeaseStatus): Promise<LeaseAgreement | null>
  markTenantSigned(leaseId: string, signatureRef: string): Promise<LeaseAgreement | null>
  markLandlordSigned(leaseId: string, signatureRef: string): Promise<LeaseAgreement | null>
  void(leaseId: string): Promise<LeaseAgreement | null>
  /** Test helper: overwrite the recorded document hash (in-memory adapter only). */
  setDocumentHashForTest(leaseId: string, documentHash: string): Promise<void>
  clear(): Promise<void>
}

class InMemoryLeaseAgreementStore implements LeaseAgreementStorePort {
  private leases = new Map<string, LeaseAgreement>()
  private dealIndex = new Map<string, string>() // dealId -> leaseId

  async create(input: CreateLeaseInput): Promise<LeaseAgreement> {
    const now = new Date()
    const lease: LeaseAgreement = {
      leaseId: randomUUID(),
      dealId: input.dealId,
      documentKey: input.documentKey,
      documentHash: input.documentHash,
      templateVersion: input.templateVersion,
      status: LeaseStatus.DRAFT,
      createdAt: now,
      updatedAt: now,
    }

    this.leases.set(lease.leaseId, lease)
    this.dealIndex.set(input.dealId, lease.leaseId)
    return lease
  }

  async getById(leaseId: string): Promise<LeaseAgreement | null> {
    return this.leases.get(leaseId) ?? null
  }

  async getByDealId(dealId: string): Promise<LeaseAgreement | null> {
    const leaseId = this.dealIndex.get(dealId)
    if (!leaseId) return null
    return this.leases.get(leaseId) ?? null
  }

  async updateStatus(leaseId: string, status: LeaseStatus): Promise<LeaseAgreement | null> {
    const lease = this.leases.get(leaseId)
    if (!lease) return null

    lease.status = status
    lease.updatedAt = new Date()
    this.leases.set(leaseId, lease)
    return lease
  }

  async markTenantSigned(leaseId: string, signatureRef: string): Promise<LeaseAgreement | null> {
    const lease = this.leases.get(leaseId)
    if (!lease) return null

    lease.tenantSignedAt = new Date()
    lease.tenantSignatureRef = signatureRef
    lease.status = LeaseStatus.PENDING_LANDLORD_SIGNATURE
    lease.updatedAt = new Date()
    this.leases.set(leaseId, lease)
    return lease
  }

  async markLandlordSigned(leaseId: string, signatureRef: string): Promise<LeaseAgreement | null> {
    const lease = this.leases.get(leaseId)
    if (!lease) return null

    lease.landlordSignedAt = new Date()
    lease.landlordSignatureRef = signatureRef
    lease.status = LeaseStatus.FULLY_SIGNED
    lease.updatedAt = new Date()
    this.leases.set(leaseId, lease)
    return lease
  }

  async void(leaseId: string): Promise<LeaseAgreement | null> {
    const lease = this.leases.get(leaseId)
    if (!lease) return null

    lease.status = LeaseStatus.VOIDED
    lease.updatedAt = new Date()
    this.leases.set(leaseId, lease)
    return lease
  }

  async setDocumentHashForTest(leaseId: string, documentHash: string): Promise<void> {
    const lease = this.leases.get(leaseId)
    if (!lease) throw new Error(`Lease ${leaseId} not found`)
    lease.documentHash = documentHash
  }

  async clear(): Promise<void> {
    this.leases.clear()
    this.dealIndex.clear()
  }
}

type LeaseRow = {
  lease_id: string
  deal_id: string
  document_key: string
  document_hash: string | null
  template_version: string | null
  status: LeaseStatus
  tenant_signed_at: Date | null
  landlord_signed_at: Date | null
  tenant_signature_ref: string | null
  landlord_signature_ref: string | null
  created_at: Date
  updated_at: Date
}

class PostgresLeaseAgreementStore implements LeaseAgreementStorePort {
  private async pool(): Promise<PgPoolLike> {
    const pool = await getPool()
    if (!pool) {
      throw new Error('Database pool is not available (DATABASE_URL/pg not configured)')
    }
    return pool
  }

  async isAvailable(): Promise<boolean> {
    return (await getPool()) !== null
  }

  async create(input: CreateLeaseInput): Promise<LeaseAgreement> {
    const pool = await this.pool()
    const leaseId = randomUUID()

    const { rows } = await pool.query(
      `INSERT INTO lease_agreements (lease_id, deal_id, document_key, document_hash, template_version, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        leaseId,
        input.dealId,
        input.documentKey,
        input.documentHash ?? null,
        input.templateVersion ?? null,
        LeaseStatus.DRAFT,
      ],
    )

    return this.mapRow(rows[0] as LeaseRow)
  }

  async getById(leaseId: string): Promise<LeaseAgreement | null> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      'SELECT * FROM lease_agreements WHERE lease_id = $1',
      [leaseId],
    )

    if (rows.length === 0) return null
    return this.mapRow(rows[0] as LeaseRow)
  }

  async getByDealId(dealId: string): Promise<LeaseAgreement | null> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      'SELECT * FROM lease_agreements WHERE deal_id = $1 AND status != $2 ORDER BY created_at DESC LIMIT 1',
      [dealId, LeaseStatus.VOIDED],
    )

    if (rows.length === 0) return null
    return this.mapRow(rows[0] as LeaseRow)
  }

  async updateStatus(leaseId: string, status: LeaseStatus): Promise<LeaseAgreement | null> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      `UPDATE lease_agreements SET status = $2, updated_at = NOW()
       WHERE lease_id = $1 RETURNING *`,
      [leaseId, status],
    )

    if (rows.length === 0) return null
    return this.mapRow(rows[0] as LeaseRow)
  }

  async markTenantSigned(leaseId: string, signatureRef: string): Promise<LeaseAgreement | null> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      `UPDATE lease_agreements
       SET tenant_signed_at = NOW(), tenant_signature_ref = $2,
           status = $3, updated_at = NOW()
       WHERE lease_id = $1 RETURNING *`,
      [leaseId, signatureRef, LeaseStatus.PENDING_LANDLORD_SIGNATURE],
    )

    if (rows.length === 0) return null
    return this.mapRow(rows[0] as LeaseRow)
  }

  async markLandlordSigned(leaseId: string, signatureRef: string): Promise<LeaseAgreement | null> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      `UPDATE lease_agreements
       SET landlord_signed_at = NOW(), landlord_signature_ref = $2,
           status = $3, updated_at = NOW()
       WHERE lease_id = $1 RETURNING *`,
      [leaseId, signatureRef, LeaseStatus.FULLY_SIGNED],
    )

    if (rows.length === 0) return null
    return this.mapRow(rows[0] as LeaseRow)
  }

  async void(leaseId: string): Promise<LeaseAgreement | null> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      `UPDATE lease_agreements SET status = $2, updated_at = NOW()
       WHERE lease_id = $1 RETURNING *`,
      [leaseId, LeaseStatus.VOIDED],
    )

    if (rows.length === 0) return null
    return this.mapRow(rows[0] as LeaseRow)
  }

  async setDocumentHashForTest(leaseId: string, documentHash: string): Promise<void> {
    const pool = await this.pool()
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('setDocumentHashForTest is only supported in test env')
    }
    await pool.query('UPDATE lease_agreements SET document_hash = $2 WHERE lease_id = $1', [
      leaseId,
      documentHash,
    ])
  }

  async clear(): Promise<void> {
    const pool = await this.pool()
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('leaseAgreementStore.clear() is only supported in test env')
    }
    await pool.query('TRUNCATE lease_agreements RESTART IDENTITY CASCADE')
  }

  private mapRow(row: LeaseRow): LeaseAgreement {
    return {
      leaseId: row.lease_id,
      dealId: row.deal_id,
      documentKey: row.document_key,
      documentHash: row.document_hash ?? undefined,
      templateVersion: row.template_version ?? undefined,
      status: row.status,
      tenantSignedAt: row.tenant_signed_at ? new Date(row.tenant_signed_at) : undefined,
      landlordSignedAt: row.landlord_signed_at ? new Date(row.landlord_signed_at) : undefined,
      tenantSignatureRef: row.tenant_signature_ref ?? undefined,
      landlordSignatureRef: row.landlord_signature_ref ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }
  }
}

class HybridLeaseAgreementStore implements LeaseAgreementStorePort {
  private memory = new InMemoryLeaseAgreementStore()
  private postgres = new PostgresLeaseAgreementStore()

  private async adapter(): Promise<LeaseAgreementStorePort> {
    if (await this.postgres.isAvailable()) {
      return this.postgres
    }
    return this.memory
  }

  async create(input: CreateLeaseInput): Promise<LeaseAgreement> {
    return (await this.adapter()).create(input)
  }

  async getById(leaseId: string): Promise<LeaseAgreement | null> {
    return (await this.adapter()).getById(leaseId)
  }

  async getByDealId(dealId: string): Promise<LeaseAgreement | null> {
    return (await this.adapter()).getByDealId(dealId)
  }

  async updateStatus(leaseId: string, status: LeaseStatus): Promise<LeaseAgreement | null> {
    return (await this.adapter()).updateStatus(leaseId, status)
  }

  async markTenantSigned(leaseId: string, signatureRef: string): Promise<LeaseAgreement | null> {
    return (await this.adapter()).markTenantSigned(leaseId, signatureRef)
  }

  async markLandlordSigned(leaseId: string, signatureRef: string): Promise<LeaseAgreement | null> {
    return (await this.adapter()).markLandlordSigned(leaseId, signatureRef)
  }

  async void(leaseId: string): Promise<LeaseAgreement | null> {
    return (await this.adapter()).void(leaseId)
  }

  async setDocumentHashForTest(leaseId: string, documentHash: string): Promise<void> {
    return (await this.adapter()).setDocumentHashForTest(leaseId, documentHash)
  }

  async clear(): Promise<void> {
    return (await this.adapter()).clear()
  }
}

export const leaseAgreementStore = new HybridLeaseAgreementStore()
