import { randomUUID } from 'node:crypto'
import { getPool } from '../db.js'
import { logger } from '../utils/logger.js'
import { auditLog } from '../utils/auditLogger.js'
import type {
  ErasureRequestStore,
  ListErasureRequestsFilter,
} from '../models/erasureRequestStore.js'

export type ErasureRequestStatus = 'pending' | 'completed' | 'cancelled' | 'expired'

export interface ErasureRequest {
  id: string
  userId: string
  status: ErasureRequestStatus
  requestedAt: Date
  confirmBy: Date
  confirmedAt: Date | null
  confirmedBy: string | null
}

export const ERASURE_CONFIRM_DAYS = 30

/** Audit a pending request lapsing past confirm_by (system actor). */
export function auditErasureExpired(requestId: string, userId: string): void {
  auditLog(
    'USER_ERASURE_EXPIRED',
    { userId, requestId: 'unknown', ip: 'unknown', actorType: 'system' },
    { erasureRequestId: requestId },
  )
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

function erasedToken(): string {
  return `[ERASED_${randomUUID()}]`
}

/**
 * PostgreSQL-backed erasure request store (see models/erasureRequestStore.ts).
 */
export class ErasureService implements ErasureRequestStore {
  private async pool() {
    const pool = await getPool()
    if (!pool) throw new Error('Database not configured')
    return pool
  }

  async requestErasure(userId: string): Promise<ErasureRequest> {
    const pool = await this.pool()

    const existing = await pool.query(
      `SELECT id FROM erasure_requests WHERE user_id = $1 AND status = 'pending'`,
      [userId],
    )
    if (existing.rows.length > 0) {
      throw new Error('ERASURE_ALREADY_PENDING')
    }

    const confirmBy = new Date(Date.now() + ERASURE_CONFIRM_DAYS * 24 * 60 * 60 * 1000)
    try {
      const { rows } = await pool.query(
        `INSERT INTO erasure_requests (user_id, confirm_by)
         VALUES ($1, $2)
         RETURNING *`,
        [userId, confirmBy],
      )
      return this.mapRow(rows[0])
    } catch (err) {
      // erasure_requests_one_pending_per_user_uidx closes the check-then-insert race
      if (isUniqueViolation(err)) throw new Error('ERASURE_ALREADY_PENDING')
      throw err
    }
  }

  async findLatestByUserId(userId: string): Promise<ErasureRequest | null> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      `SELECT * FROM erasure_requests WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 1`,
      [userId],
    )
    return rows.length > 0 ? this.mapRow(rows[0]) : null
  }

  async list(
    filter: ListErasureRequestsFilter = {},
  ): Promise<{ requests: ErasureRequest[]; total: number }> {
    const pool = await this.pool()
    const status = filter.status ?? null
    const { rows } = await pool.query(
      `SELECT * FROM erasure_requests
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY requested_at DESC
       LIMIT $2 OFFSET $3`,
      [status, filter.limit ?? 50, filter.offset ?? 0],
    )
    const count = await pool.query(
      `SELECT COUNT(*)::int AS total FROM erasure_requests WHERE ($1::text IS NULL OR status = $1)`,
      [status],
    )
    return {
      requests: rows.map((row: Record<string, unknown>) => this.mapRow(row)),
      total: Number(count.rows[0]?.total ?? 0),
    }
  }

  async cancelErasure(requestId: string): Promise<ErasureRequest | null> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      `UPDATE erasure_requests SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [requestId],
    )
    return rows.length > 0 ? this.mapRow(rows[0]) : null
  }

  async findPendingByUserId(userId: string): Promise<ErasureRequest | null> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      `SELECT * FROM erasure_requests WHERE user_id = $1 AND status = 'pending' ORDER BY requested_at DESC LIMIT 1`,
      [userId],
    )
    return rows.length > 0 ? this.mapRow(rows[0]) : null
  }

  async findById(id: string): Promise<ErasureRequest | null> {
    const pool = await this.pool()
    const { rows } = await pool.query(`SELECT * FROM erasure_requests WHERE id = $1`, [id])
    return rows.length > 0 ? this.mapRow(rows[0]) : null
  }

  /**
   * Anonymise PII fields across users, landlord profiles, onboarding drafts, KYC docs,
   * messages, tenant document vault records, support messages, notifications, apartment reviews,
   * and revoke sessions, all within a single atomic transaction.
   */
  async confirmErasure(requestId: string, adminUserId: string): Promise<void> {
    const pool = await this.pool()
    const request = await this.findById(requestId)
    if (!request) throw new Error('ERASURE_NOT_FOUND')
    if (request.status !== 'pending') throw new Error('ERASURE_NOT_PENDING')

    const token = erasedToken()
    const userId = request.userId

    await pool.query('BEGIN')
    try {
      await pool.query(
        `UPDATE users SET
           email = $2,
           name = $3,
           wallet_address = NULL,
           deactivated_at = NOW(),
           updated_at = NOW()
         WHERE id = $1`,
        [userId, `${token}@erased.local`, token],
      )

      await pool.query(
        `UPDATE landlord_profiles SET
           phone = $2,
           address = $2,
           account_number = $2,
           account_name = $2,
           bank_name = NULL,
           updated_at = NOW()
         WHERE user_id = $1`,
        [userId, token],
      )

      await pool.query(
        `UPDATE onboarding_drafts SET
           personal_info = jsonb_build_object('erased', true),
           employment_info = NULL,
           documents = NULL,
           wallet_info = NULL,
           updated_at = NOW()
         WHERE user_id = $1`,
        [userId],
      )

      await pool.query(
        `UPDATE kyc_documents SET
           front_image_key = $2,
           back_image_key = $2,
           liveness_signal = NULL,
           rejection_reason = NULL,
           updated_at = NOW()
         WHERE user_id = $1`,
        [userId, token],
      )

      // Cascade to messages / conversations (sender references & body content)
      await pool.query(
        `UPDATE messages SET
           body = $2,
           sender_id = $3,
           updated_at = NOW()
         WHERE sender_id = $1 OR recipient_id = $1`,
        [userId, '[ERASED_MESSAGE]', token],
      )

      // Cascade to tenant document vault records
      await pool.query(
        `UPDATE tenant_documents SET
           file_name = $2,
           storage_key = $2,
           description = NULL,
           tags = '[]'::jsonb,
           updated_at = NOW()
         WHERE user_id = $1`,
        [userId, token],
      )

      // Cascade to support messages
      await pool.query(
        `UPDATE support_messages SET
           name = $2,
           email = $3,
           phone = NULL,
           message = $4,
           ip = NULL,
           user_agent = NULL
         WHERE email = (SELECT email FROM users WHERE id = $1) OR name = $1 OR user_id = $1`,
        [userId, token, `${token}@erased.local`, '[ERASED_SUPPORT_MESSAGE]'],
      )

      // Cascade to notification records
      await pool.query(
        `UPDATE notifications SET
           recipient = $2,
           title = $3,
           body = $3,
           payload = '{}'::jsonb,
           updated_at = NOW()
         WHERE recipient = $1 OR user_id = $1`,
        [userId, `${token}@erased.local`, token],
      )

      // Cascade to apartment reviews / property reviews author references
      await pool.query(
        `UPDATE apartment_reviews SET
           author_name = $2,
           comment = $3,
           updated_at = NOW()
         WHERE author_id = $1 OR user_id = $1`,
        [userId, token, '[ERASED_REVIEW]'],
      )

      await pool.query(
        `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      )

      await pool.query(
        `UPDATE erasure_requests SET
           status = 'completed',
           confirmed_at = NOW(),
           confirmed_by = $2,
           updated_at = NOW()
         WHERE id = $1`,
        [requestId, adminUserId],
      )

      await pool.query('COMMIT')
      logger.info('erasure.completed', { userId, requestId, adminUserId })
    } catch (err) {
      await pool.query('ROLLBACK')
      throw err
    }
  }

  async expireOverdueRequests(now = new Date()): Promise<number> {
    const pool = await this.pool()
    const { rows, rowCount } = await pool.query(
      `UPDATE erasure_requests SET status = 'expired', updated_at = NOW()
       WHERE status = 'pending' AND confirm_by < $1
       RETURNING id, user_id`,
      [now],
    )
    for (const row of rows ?? []) {
      auditErasureExpired(row.id as string, row.user_id as string)
    }
    return rowCount ?? 0
  }

  private mapRow(row: Record<string, unknown>): ErasureRequest {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      status: row.status as ErasureRequestStatus,
      requestedAt: new Date(row.requested_at as string),
      confirmBy: new Date(row.confirm_by as string),
      confirmedAt: row.confirmed_at ? new Date(row.confirmed_at as string) : null,
      confirmedBy: (row.confirmed_by as string) ?? null,
    }
  }
}

export const erasureService = new ErasureService()
