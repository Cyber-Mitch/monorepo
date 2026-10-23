/**
 * Tenant Reputation Store — issue #1980.
 *
 * Caches the last-published reputation record per tenant so that
 * `syncTenantReputation` can perform a change-only enqueue — it only writes
 * to the outbox when the recomputed record differs from the stored one.
 *
 * The store does **not** own the authoritative score; the outbox item and the
 * on-chain contract are the authority. This table is a local cache used
 * exclusively for deduplication.
 */

import { randomUUID } from 'node:crypto'
import { getPool } from '../db.js'
import type { ReputationRecord } from '../services/tenantReputationService.js'

// ── Domain types ───────────────────────────────────────────────────────────

export interface TenantReputationScoreRecord {
  id: string
  tenantId: string
  compositeScore: number
  paymentScore: number
  propertyCareScore: number
  communicationScore: number
  totalRatings: number
  updatedAt: Date
}

// ── Store interface ────────────────────────────────────────────────────────

export interface TenantReputationStore {
  /**
   * Find the cached record for a tenant, or `null` when none exists yet.
   */
  findByTenantId(tenantId: string): Promise<TenantReputationScoreRecord | null>

  /**
   * Insert or update the cached record for a tenant.
   * Returns the saved record.
   */
  upsert(tenantId: string, record: ReputationRecord): Promise<TenantReputationScoreRecord>

  /**
   * List all cached records (used by the backfill script and admin endpoint).
   * @param limit - Optional page size; defaults to 100.
   * @param offset - Optional offset for pagination; defaults to 0.
   */
  list(limit?: number, offset?: number): Promise<TenantReputationScoreRecord[]>
}

// ── In-memory implementation (tests / no-DB mode) ─────────────────────────

export class InMemoryTenantReputationStore implements TenantReputationStore {
  private records = new Map<string, TenantReputationScoreRecord>()

  async findByTenantId(tenantId: string): Promise<TenantReputationScoreRecord | null> {
    return this.records.get(tenantId) ?? null
  }

  async upsert(tenantId: string, record: ReputationRecord): Promise<TenantReputationScoreRecord> {
    const existing = this.records.get(tenantId)
    const saved: TenantReputationScoreRecord = {
      id:                 existing?.id ?? randomUUID(),
      tenantId,
      compositeScore:     record.compositeScore,
      paymentScore:       record.paymentScore,
      propertyCareScore:  record.propertyCareScore,
      communicationScore: record.communicationScore,
      totalRatings:       record.totalRatings,
      updatedAt:          new Date(),
    }
    this.records.set(tenantId, saved)
    return { ...saved }
  }

  async list(limit = 100, offset = 0): Promise<TenantReputationScoreRecord[]> {
    return Array.from(this.records.values())
      .sort((a, b) => a.tenantId.localeCompare(b.tenantId))
      .slice(offset, offset + limit)
      .map((r) => ({ ...r }))
  }

  /** Test helper */
  async clear(): Promise<void> {
    this.records.clear()
  }
}

// ── Postgres implementation ────────────────────────────────────────────────

const COLUMNS = `id, tenant_id, composite_score, payment_score,
  property_care_score, communication_score, total_ratings, updated_at`

function mapRow(row: Record<string, unknown>): TenantReputationScoreRecord {
  return {
    id:                 row.id as string,
    tenantId:           row.tenant_id as string,
    compositeScore:     Number(row.composite_score),
    paymentScore:       Number(row.payment_score),
    propertyCareScore:  Number(row.property_care_score),
    communicationScore: Number(row.communication_score),
    totalRatings:       Number(row.total_ratings),
    updatedAt:          new Date(row.updated_at as string),
  }
}

export class PostgresTenantReputationStore implements TenantReputationStore {
  async findByTenantId(tenantId: string): Promise<TenantReputationScoreRecord | null> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const { rows } = await pool.query(
      `SELECT ${COLUMNS}
       FROM tenant_reputation_scores
       WHERE tenant_id = $1`,
      [tenantId],
    )
    return rows[0] ? mapRow(rows[0]) : null
  }

  async upsert(tenantId: string, record: ReputationRecord): Promise<TenantReputationScoreRecord> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const { rows } = await pool.query(
      `INSERT INTO tenant_reputation_scores
         (tenant_id, composite_score, payment_score, property_care_score,
          communication_score, total_ratings)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id) DO UPDATE SET
         composite_score     = EXCLUDED.composite_score,
         payment_score       = EXCLUDED.payment_score,
         property_care_score = EXCLUDED.property_care_score,
         communication_score = EXCLUDED.communication_score,
         total_ratings       = EXCLUDED.total_ratings,
         updated_at          = NOW()
       RETURNING ${COLUMNS}`,
      [
        tenantId,
        record.compositeScore,
        record.paymentScore,
        record.propertyCareScore,
        record.communicationScore,
        record.totalRatings,
      ],
    )
    return mapRow(rows[0])
  }

  async list(limit = 100, offset = 0): Promise<TenantReputationScoreRecord[]> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const { rows } = await pool.query(
      `SELECT ${COLUMNS}
       FROM tenant_reputation_scores
       ORDER BY updated_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    )
    return rows.map((r: Record<string, unknown>) => mapRow(r))
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let tenantReputationStore: TenantReputationStore = new InMemoryTenantReputationStore()

export function initTenantReputationStore(store: TenantReputationStore): void {
  tenantReputationStore = store
}

export { tenantReputationStore }
