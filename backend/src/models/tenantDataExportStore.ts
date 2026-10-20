/**
 * Tenant Data Export Store — issue #1899. Backed by `tenant_data_exports`
 * (migrations/20261019120200). Every read in the routes is scoped by user id.
 */

import { randomUUID } from 'node:crypto'
import { getPool } from '../db.js'

export type TenantDataExportStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'expired'

export interface TenantDataExport {
  id: string
  userId: string
  status: TenantDataExportStatus
  storageKey: string | null
  failureReason: string | null
  requestedAt: Date
  completedAt: Date | null
  expiresAt: Date | null
}

export type TenantDataExportPatch = Partial<
  Pick<TenantDataExport, 'status' | 'storageKey' | 'failureReason' | 'completedAt' | 'expiresAt'>
>

export interface TenantDataExportStore {
  create(userId: string): Promise<TenantDataExport>
  findById(id: string): Promise<TenantDataExport | null>
  findLatestByUserId(userId: string): Promise<TenantDataExport | null>
  findActiveByUserId(userId: string): Promise<TenantDataExport | null>
  update(id: string, patch: TenantDataExportPatch): Promise<TenantDataExport | null>
  /** Archives that are ready but whose expiry has passed. */
  listExpiredReady(now: Date): Promise<TenantDataExport[]>
}

const ACTIVE: TenantDataExportStatus[] = ['pending', 'processing']

function isActive(status: TenantDataExportStatus): boolean {
  return ACTIVE.includes(status)
}

export class InMemoryTenantDataExportStore implements TenantDataExportStore {
  private exports = new Map<string, TenantDataExport>()

  async create(userId: string): Promise<TenantDataExport> {
    const record: TenantDataExport = {
      id: randomUUID(),
      userId,
      status: 'pending',
      storageKey: null,
      failureReason: null,
      requestedAt: new Date(),
      completedAt: null,
      expiresAt: null,
    }
    this.exports.set(record.id, record)
    return { ...record }
  }

  async findById(id: string): Promise<TenantDataExport | null> {
    const record = this.exports.get(id)
    return record ? { ...record } : null
  }

  private forUser(userId: string): TenantDataExport[] {
    return [...this.exports.values()]
      .filter((e) => e.userId === userId)
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
  }

  async findLatestByUserId(userId: string): Promise<TenantDataExport | null> {
    const latest = this.forUser(userId)[0]
    return latest ? { ...latest } : null
  }

  async findActiveByUserId(userId: string): Promise<TenantDataExport | null> {
    const active = this.forUser(userId).find((e) => isActive(e.status))
    return active ? { ...active } : null
  }

  async update(id: string, patch: TenantDataExportPatch): Promise<TenantDataExport | null> {
    const record = this.exports.get(id)
    if (!record) return null
    Object.assign(record, patch)
    return { ...record }
  }

  async listExpiredReady(now: Date): Promise<TenantDataExport[]> {
    return [...this.exports.values()]
      .filter((e) => e.status === 'ready' && e.expiresAt !== null && e.expiresAt <= now)
      .map((e) => ({ ...e }))
  }

  // Test helper
  async clear(): Promise<void> {
    this.exports.clear()
  }
}

type ExportRow = {
  id: string
  user_id: string
  status: TenantDataExportStatus
  storage_key: string | null
  failure_reason: string | null
  requested_at: Date
  completed_at: Date | null
  expires_at: Date | null
}

const COLUMNS = `id, user_id, status, storage_key, failure_reason, requested_at, completed_at, expires_at`

export class PostgresTenantDataExportStore implements TenantDataExportStore {
  private async pool() {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    return pool
  }

  async create(userId: string): Promise<TenantDataExport> {
    const pool = await this.pool()
    const result = await pool.query(
      `INSERT INTO tenant_data_exports (id, user_id, status)
       VALUES ($1, $2, 'pending')
       RETURNING ${COLUMNS}`,
      [randomUUID(), userId],
    )
    return this.mapRow(result.rows[0] as ExportRow)
  }

  async findById(id: string): Promise<TenantDataExport | null> {
    const pool = await this.pool()
    const result = await pool.query(`SELECT ${COLUMNS} FROM tenant_data_exports WHERE id = $1`, [id])
    return result.rows[0] ? this.mapRow(result.rows[0] as ExportRow) : null
  }

  async findLatestByUserId(userId: string): Promise<TenantDataExport | null> {
    const pool = await this.pool()
    const result = await pool.query(
      `SELECT ${COLUMNS} FROM tenant_data_exports
       WHERE user_id = $1
       ORDER BY requested_at DESC
       LIMIT 1`,
      [userId],
    )
    return result.rows[0] ? this.mapRow(result.rows[0] as ExportRow) : null
  }

  async findActiveByUserId(userId: string): Promise<TenantDataExport | null> {
    const pool = await this.pool()
    const result = await pool.query(
      `SELECT ${COLUMNS} FROM tenant_data_exports
       WHERE user_id = $1 AND status IN ('pending', 'processing')
       LIMIT 1`,
      [userId],
    )
    return result.rows[0] ? this.mapRow(result.rows[0] as ExportRow) : null
  }

  async update(id: string, patch: TenantDataExportPatch): Promise<TenantDataExport | null> {
    const pool = await this.pool()
    const sets: string[] = []
    const params: unknown[] = []
    const column: Record<keyof TenantDataExportPatch, string> = {
      status: 'status',
      storageKey: 'storage_key',
      failureReason: 'failure_reason',
      completedAt: 'completed_at',
      expiresAt: 'expires_at',
    }
    for (const key of Object.keys(patch) as (keyof TenantDataExportPatch)[]) {
      params.push(patch[key] ?? null)
      sets.push(`${column[key]} = $${params.length}`)
    }
    if (sets.length === 0) return this.findById(id)
    params.push(id)
    const result = await pool.query(
      `UPDATE tenant_data_exports
       SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length}
       RETURNING ${COLUMNS}`,
      params,
    )
    return result.rows[0] ? this.mapRow(result.rows[0] as ExportRow) : null
  }

  async listExpiredReady(now: Date): Promise<TenantDataExport[]> {
    const pool = await this.pool()
    const result = await pool.query(
      `SELECT ${COLUMNS} FROM tenant_data_exports
       WHERE status = 'ready' AND expires_at <= $1
       ORDER BY expires_at ASC
       LIMIT 100`,
      [now],
    )
    return result.rows.map((row: ExportRow) => this.mapRow(row))
  }

  private mapRow(row: ExportRow): TenantDataExport {
    return {
      id: row.id,
      userId: row.user_id,
      status: row.status,
      storageKey: row.storage_key,
      failureReason: row.failure_reason,
      requestedAt: new Date(row.requested_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    }
  }
}

let tenantDataExportStore: TenantDataExportStore = new InMemoryTenantDataExportStore()

export function initTenantDataExportStore(store: TenantDataExportStore): void {
  tenantDataExportStore = store
}

export { tenantDataExportStore }
