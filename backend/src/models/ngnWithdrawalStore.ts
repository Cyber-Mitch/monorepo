/**
 * Persistence for NGN withdrawals (#1944).
 *
 * A withdrawal's status and the ledger entry that reserves or releases its funds change together:
 * `createWithReservation` inserts the withdrawal and its WITHDRAWAL_PENDING entry, and
 * `transition` moves the status and writes the matching entry. In Postgres both happen in one
 * transaction, so a withdrawal can never be left reserved without a record, or recorded without
 * its ledger entry. A transition only applies from the statuses it lists, which makes every
 * change idempotent: repeating it finds the withdrawal already moved and writes nothing.
 */

import { randomUUID } from 'node:crypto'
import { getPool } from '../db.js'
import type { LedgerEntryType, NgnWalletStore } from './ngnWallet.js'
import { ngnWalletStore } from './ngnWalletStore.js'

export type NgnWithdrawalStatus =
  | 'pending'
  | 'approved'
  | 'processing'
  | 'confirmed'
  | 'failed'
  | 'rejected'

export const NGN_WITHDRAWAL_STATUSES: readonly NgnWithdrawalStatus[] = [
  'pending',
  'approved',
  'processing',
  'confirmed',
  'failed',
  'rejected',
]

/** Which statuses each status may move to. Terminal statuses move nowhere. */
export const NGN_WITHDRAWAL_TRANSITIONS: Record<NgnWithdrawalStatus, readonly NgnWithdrawalStatus[]> = {
  pending: ['approved', 'rejected', 'confirmed', 'failed'],
  approved: ['processing', 'rejected', 'confirmed', 'failed'],
  processing: ['confirmed', 'failed'],
  confirmed: [],
  failed: [],
  rejected: [],
}

export interface NgnWithdrawalRecord {
  id: string
  userId: string
  walletId: string
  amountNgn: number
  bankAccount: { accountNumber: string; accountName: string; bankName: string }
  status: NgnWithdrawalStatus
  reference: string
  failureReason: string | null
  approvedBy: string | null
  approvedAt: Date | null
  payoutStartedAt: Date | null
  processedAt: Date | null
  createdAt: Date
}

export type NewNgnWithdrawal = Pick<
  NgnWithdrawalRecord,
  'id' | 'userId' | 'walletId' | 'amountNgn' | 'bankAccount' | 'reference'
>

export interface LedgerWrite {
  walletId: string
  type: LedgerEntryType
  amountNgn: number
  referenceType: string
  referenceId: string
}

export interface WithdrawalTransition {
  /** The statuses the withdrawal may currently be in for this change to apply. */
  from: readonly NgnWithdrawalStatus[]
  to: NgnWithdrawalStatus
  patch?: Partial<
    Pick<NgnWithdrawalRecord, 'failureReason' | 'approvedBy' | 'approvedAt' | 'payoutStartedAt' | 'processedAt'>
  >
  /** Written in the same transaction, only if the transition applied. */
  ledger?: LedgerWrite
}

export interface WithdrawalListOptions {
  userId?: string
  status?: NgnWithdrawalStatus
  limit?: number
  /** Opaque cursor from a previous page. */
  cursor?: string
}

export interface NgnWithdrawalStore {
  createWithReservation(input: NewNgnWithdrawal, reservation: LedgerWrite): Promise<NgnWithdrawalRecord>
  getById(id: string): Promise<NgnWithdrawalRecord | null>
  /** Newest first. */
  list(options?: WithdrawalListOptions): Promise<{ items: NgnWithdrawalRecord[]; nextCursor: string | null }>
  /**
   * Applies the transition if the withdrawal is currently in one of `from`. Returns null when the
   * withdrawal does not exist, and `changed: false` (with the current record) when it was not in a
   * `from` status, in which case nothing is written.
   */
  transition(
    id: string,
    change: WithdrawalTransition,
  ): Promise<{ record: NgnWithdrawalRecord; changed: boolean } | null>
  clear(): Promise<void>
}

const PAGE_DEFAULT = 20
const PAGE_MAX = 100

const clampLimit = (limit?: number) => Math.min(PAGE_MAX, Math.max(1, limit ?? PAGE_DEFAULT))

// Cursor: base64 of "<createdAt ms>|<id>", matching the newest-first order.
const encodeCursor = (r: NgnWithdrawalRecord) =>
  Buffer.from(`${r.createdAt.getTime()}|${r.id}`).toString('base64url')
const decodeCursor = (cursor: string): { at: number; id: string } | null => {
  try {
    const [at, ...rest] = Buffer.from(cursor, 'base64url').toString().split('|')
    const id = rest.join('|')
    return Number.isFinite(Number(at)) && id ? { at: Number(at), id } : null
  } catch {
    return null
  }
}

export class InMemoryNgnWithdrawalStore implements NgnWithdrawalStore {
  private rows = new Map<string, NgnWithdrawalRecord>()
  private seq = 0
  private order = new Map<string, number>()

  /** Ledger entries go to the wallet store this store is paired with. */
  constructor(private readonly wallets: () => NgnWalletStore) {}

  private copy(r: NgnWithdrawalRecord): NgnWithdrawalRecord {
    return { ...r, bankAccount: { ...r.bankAccount } }
  }

  async createWithReservation(input: NewNgnWithdrawal, reservation: LedgerWrite) {
    if (this.rows.has(input.id)) throw new Error(`Withdrawal ${input.id} already exists`)
    // Written before the record so a failure leaves nothing reserved without a withdrawal.
    const record: NgnWithdrawalRecord = {
      ...input,
      bankAccount: { ...input.bankAccount },
      status: 'pending',
      failureReason: null,
      approvedBy: null,
      approvedAt: null,
      payoutStartedAt: null,
      processedAt: null,
      createdAt: new Date(),
    }
    await this.wallets().createLedgerEntry(reservation)
    this.rows.set(record.id, record)
    this.order.set(record.id, this.seq++)
    return this.copy(record)
  }

  async getById(id: string) {
    const r = this.rows.get(id)
    return r ? this.copy(r) : null
  }

  async list(options: WithdrawalListOptions = {}) {
    const limit = clampLimit(options.limit)
    const cursor = options.cursor ? decodeCursor(options.cursor) : null
    let items = [...this.rows.values()]
      .filter((r) => !options.userId || r.userId === options.userId)
      .filter((r) => !options.status || r.status === options.status)
      .sort((a, b) => (this.order.get(b.id) ?? 0) - (this.order.get(a.id) ?? 0))
    if (cursor) {
      const at = this.order.get(cursor.id)
      items = at === undefined ? [] : items.filter((r) => (this.order.get(r.id) ?? 0) < at)
    }
    const page = items.slice(0, limit)
    return {
      items: page.map((r) => this.copy(r)),
      nextCursor: items.length > limit ? encodeCursor(page[page.length - 1]) : null,
    }
  }

  async transition(id: string, change: WithdrawalTransition) {
    const r = this.rows.get(id)
    if (!r) return null
    if (!change.from.includes(r.status)) return { record: this.copy(r), changed: false }
    if (change.ledger) await this.wallets().createLedgerEntry(change.ledger)
    r.status = change.to
    Object.assign(r, change.patch ?? {})
    return { record: this.copy(r), changed: true }
  }

  async clear() {
    this.rows.clear()
    this.order.clear()
    this.seq = 0
  }
}

type Row = Record<string, unknown>

function mapRow(row: Row): NgnWithdrawalRecord {
  const date = (v: unknown) => (v ? new Date(v as string) : null)
  return {
    id: row.id as string,
    userId: row.user_id as string,
    walletId: row.wallet_id as string,
    amountNgn: Number(row.amount_ngn),
    bankAccount: {
      accountNumber: row.bank_account_number as string,
      accountName: row.bank_account_name as string,
      bankName: row.bank_name as string,
    },
    status: row.status as NgnWithdrawalStatus,
    reference: row.reference as string,
    failureReason: (row.failure_reason as string | null) ?? null,
    approvedBy: (row.approved_by as string | null) ?? null,
    approvedAt: date(row.approved_at),
    payoutStartedAt: date(row.payout_started_at),
    processedAt: date(row.processed_at),
    createdAt: new Date(row.created_at as string),
  }
}

const INSERT_LEDGER = `INSERT INTO ngn_ledger_entries (wallet_id, type, amount_ngn, reference_type, reference_id)
  VALUES ($1, $2, $3, $4, $5)`

export class PostgresNgnWithdrawalStore implements NgnWithdrawalStore {
  private async pool() {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not available')
    return pool
  }

  /** Runs `fn` in one transaction on a dedicated connection. */
  private async tx<T>(
    fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>) => Promise<T>,
  ): Promise<T> {
    const pool = await this.pool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const out = await fn((sql, params) => client.query(sql, params) as Promise<{ rows: Row[] }>)
      await client.query('COMMIT')
      return out
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async createWithReservation(input: NewNgnWithdrawal, reservation: LedgerWrite) {
    return this.tx(async (q) => {
      await q(INSERT_LEDGER, [
        reservation.walletId,
        reservation.type,
        reservation.amountNgn,
        reservation.referenceType,
        reservation.referenceId,
      ])
      const { rows } = await q(
        `INSERT INTO ngn_withdrawals
           (id, user_id, wallet_id, amount_ngn, bank_account_number, bank_account_name, bank_name, reference)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          input.id,
          input.userId,
          input.walletId,
          input.amountNgn,
          input.bankAccount.accountNumber,
          input.bankAccount.accountName,
          input.bankAccount.bankName,
          input.reference,
        ],
      )
      return mapRow(rows[0])
    })
  }

  async getById(id: string) {
    const pool = await this.pool()
    const { rows } = await pool.query('SELECT * FROM ngn_withdrawals WHERE id = $1', [id])
    return rows[0] ? mapRow(rows[0] as Row) : null
  }

  async list(options: WithdrawalListOptions = {}) {
    const pool = await this.pool()
    const limit = clampLimit(options.limit)
    const where: string[] = []
    const params: unknown[] = []
    if (options.userId) {
      params.push(options.userId)
      where.push(`user_id = $${params.length}`)
    }
    if (options.status) {
      params.push(options.status)
      where.push(`status = $${params.length}`)
    }
    const cursor = options.cursor ? decodeCursor(options.cursor) : null
    if (cursor) {
      params.push(new Date(cursor.at).toISOString(), cursor.id)
      where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`)
    }
    params.push(limit + 1)
    const { rows } = await pool.query(
      `SELECT * FROM ngn_withdrawals ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    )
    const all = (rows as Row[]).map(mapRow)
    const items = all.slice(0, limit)
    return { items, nextCursor: all.length > limit ? encodeCursor(items[items.length - 1]) : null }
  }

  async transition(id: string, change: WithdrawalTransition) {
    return this.tx(async (q) => {
      const sets = ['status = $2', 'updated_at = NOW()']
      const params: unknown[] = [id, change.to, [...change.from]]
      const columns: Record<string, string> = {
        failureReason: 'failure_reason',
        approvedBy: 'approved_by',
        approvedAt: 'approved_at',
        payoutStartedAt: 'payout_started_at',
        processedAt: 'processed_at',
      }
      for (const [key, column] of Object.entries(columns)) {
        const value = change.patch?.[key as keyof NonNullable<WithdrawalTransition['patch']>]
        if (value !== undefined) {
          params.push(value instanceof Date ? value.toISOString() : value)
          sets.push(`${column} = $${params.length}`)
        }
      }
      // The status guard in the WHERE clause is what makes a repeated change a no-op.
      const updated = await q(
        `UPDATE ngn_withdrawals SET ${sets.join(', ')} WHERE id = $1 AND status = ANY($3::text[]) RETURNING *`,
        params,
      )
      if (updated.rows.length > 0) {
        if (change.ledger) {
          await q(INSERT_LEDGER, [
            change.ledger.walletId,
            change.ledger.type,
            change.ledger.amountNgn,
            change.ledger.referenceType,
            change.ledger.referenceId,
          ])
        }
        return { record: mapRow(updated.rows[0]), changed: true }
      }
      const current = await q('SELECT * FROM ngn_withdrawals WHERE id = $1', [id])
      return current.rows[0] ? { record: mapRow(current.rows[0]), changed: false } : null
    })
  }

  async clear() {
    const pool = await getPool()
    if (pool) await pool.query('DELETE FROM ngn_withdrawals')
  }
}

/**
 * The store the app uses: in memory by default (tests, local runs), swapped for Postgres at startup
 * with `initNgnWithdrawalStore`. The in-memory one writes its ledger entries to `ngnWalletStore`.
 */
class SwitchableNgnWithdrawalStore implements NgnWithdrawalStore {
  private impl: NgnWithdrawalStore = new InMemoryNgnWithdrawalStore(() => ngnWalletStore)
  use(impl: NgnWithdrawalStore) {
    this.impl = impl
  }
  createWithReservation(input: NewNgnWithdrawal, reservation: LedgerWrite) {
    return this.impl.createWithReservation(input, reservation)
  }
  getById(id: string) {
    return this.impl.getById(id)
  }
  list(options?: WithdrawalListOptions) {
    return this.impl.list(options)
  }
  transition(id: string, change: WithdrawalTransition) {
    return this.impl.transition(id, change)
  }
  clear() {
    return this.impl.clear()
  }
}

const switchable = new SwitchableNgnWithdrawalStore()
export const ngnWithdrawalStore: NgnWithdrawalStore = switchable

export function initNgnWithdrawalStore(impl: NgnWithdrawalStore): void {
  switchable.use(impl)
}
