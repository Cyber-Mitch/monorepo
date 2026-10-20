import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryNgnWithdrawalStore,
  PostgresNgnWithdrawalStore,
  type NewNgnWithdrawal,
} from './ngnWithdrawalStore.js'
import { InMemoryNgnWalletStore } from './ngnWalletStore.js'

vi.mock('../db.js', () => ({ getPool: vi.fn() }))
import { getPool } from '../db.js'

const bank = { accountNumber: '0123456789', accountName: 'Ada Obi', bankName: 'GTBank' }
const base = (id: string, userId = 'u1'): NewNgnWithdrawal => ({
  id,
  userId,
  walletId: 'w1',
  amountNgn: 5_000,
  bankAccount: bank,
  reference: `REF-${id}`,
})
const ledger = (id: string, type: 'WITHDRAWAL_PENDING' | 'WITHDRAWAL_CONFIRMED' | 'WITHDRAWAL_FAILED', amountNgn: number) => ({
  walletId: 'w1',
  type,
  amountNgn,
  referenceType: 'withdrawal',
  referenceId: id,
})

describe('InMemoryNgnWithdrawalStore (#1944)', () => {
  let wallets: InMemoryNgnWalletStore
  let store: InMemoryNgnWithdrawalStore
  beforeEach(() => {
    wallets = new InMemoryNgnWalletStore()
    store = new InMemoryNgnWithdrawalStore(() => wallets)
  })

  it('creates a pending withdrawal and its reservation together', async () => {
    const created = await store.createWithReservation(base('a'), ledger('a', 'WITHDRAWAL_PENDING', -5_000))

    expect(created).toMatchObject({ id: 'a', status: 'pending', amountNgn: 5_000, approvedBy: null })
    expect(await wallets.getLedgerEntriesByWalletId('w1')).toHaveLength(1)
  })

  it('does not record a withdrawal when its reservation cannot be written', async () => {
    vi.spyOn(wallets, 'createLedgerEntry').mockRejectedValueOnce(new Error('ledger down'))

    await expect(store.createWithReservation(base('a'), ledger('a', 'WITHDRAWAL_PENDING', -5_000))).rejects.toThrow(
      'ledger down',
    )
    expect(await store.getById('a')).toBeNull()
  })

  it('applies a transition once: repeating it writes nothing', async () => {
    await store.createWithReservation(base('a'), ledger('a', 'WITHDRAWAL_PENDING', -5_000))

    const first = await store.transition('a', { from: ['pending'], to: 'approved', patch: { approvedBy: 'admin-1' } })
    const second = await store.transition('a', { from: ['pending'], to: 'approved', patch: { approvedBy: 'admin-2' } })

    expect(first).toMatchObject({ changed: true, record: { status: 'approved', approvedBy: 'admin-1' } })
    expect(second).toMatchObject({ changed: false, record: { status: 'approved', approvedBy: 'admin-1' } })
  })

  it('writes the ledger entry only when the transition applies', async () => {
    await store.createWithReservation(base('a'), ledger('a', 'WITHDRAWAL_PENDING', -5_000))
    const fail = { from: ['pending', 'approved'] as const, to: 'rejected' as const, ledger: ledger('a', 'WITHDRAWAL_FAILED', 5_000) }

    await store.transition('a', fail)
    await store.transition('a', fail)

    const entries = await wallets.getLedgerEntriesByWalletId('w1')
    expect(entries.map((e) => e.type)).toEqual(['WITHDRAWAL_PENDING', 'WITHDRAWAL_FAILED'])
  })

  it('returns null for an unknown withdrawal', async () => {
    expect(await store.transition('nope', { from: ['pending'], to: 'approved' })).toBeNull()
  })

  it('lists newest first, filters by status and user, and pages with a cursor', async () => {
    for (const [id, user] of [['a', 'u1'], ['b', 'u2'], ['c', 'u1'], ['d', 'u1']] as const) {
      await store.createWithReservation(base(id, user), ledger(id, 'WITHDRAWAL_PENDING', -5_000))
    }
    await store.transition('b', { from: ['pending'], to: 'approved' })

    expect((await store.list()).items.map((r) => r.id)).toEqual(['d', 'c', 'b', 'a'])
    expect((await store.list({ status: 'approved' })).items.map((r) => r.id)).toEqual(['b'])
    expect((await store.list({ userId: 'u1' })).items.map((r) => r.id)).toEqual(['d', 'c', 'a'])

    const page1 = await store.list({ limit: 2 })
    const page2 = await store.list({ limit: 2, cursor: page1.nextCursor! })
    expect(page1.items.map((r) => r.id)).toEqual(['d', 'c'])
    expect(page2.items.map((r) => r.id)).toEqual(['b', 'a'])
    expect(page2.nextCursor).toBeNull()
  })

  it('hands out copies, so callers cannot change stored state', async () => {
    await store.createWithReservation(base('a'), ledger('a', 'WITHDRAWAL_PENDING', -5_000))
    const got = (await store.getById('a'))!
    got.status = 'confirmed'
    got.bankAccount.bankName = 'Changed'

    expect(await store.getById('a')).toMatchObject({ status: 'pending', bankAccount: { bankName: 'GTBank' } })
  })
})

describe('PostgresNgnWithdrawalStore (#1944)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'a',
    user_id: 'u1',
    wallet_id: 'w1',
    amount_ngn: '5000',
    bank_account_number: '0123456789',
    bank_account_name: 'Ada Obi',
    bank_name: 'GTBank',
    status: 'pending',
    reference: 'REF-a',
    failure_reason: null,
    approved_by: null,
    approved_at: null,
    payout_started_at: null,
    processed_at: null,
    created_at: '2026-10-20T10:00:00.000Z',
    ...over,
  })

  function fakePool(handler: (sql: string, params?: unknown[]) => { rows: unknown[] } | Error) {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push(sql.trim().split(/\s+/).slice(0, 3).join(' '))
        if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rows: [] }
        const out = handler(sql, params)
        if (out instanceof Error) throw out
        return out
      }),
      release: vi.fn(),
    }
    vi.mocked(getPool).mockResolvedValue({ connect: async () => client, query: client.query } as never)
    return { calls, client }
  }

  it('writes the status change and its ledger entry in one transaction', async () => {
    const { calls } = fakePool((sql) =>
      sql.startsWith('UPDATE') ? { rows: [row({ status: 'rejected' })] } : { rows: [] },
    )

    const result = await new PostgresNgnWithdrawalStore().transition('a', {
      from: ['pending', 'approved'],
      to: 'rejected',
      ledger: ledger('a', 'WITHDRAWAL_FAILED', 5_000),
    })

    expect(result).toMatchObject({ changed: true, record: { status: 'rejected', amountNgn: 5000 } })
    expect(calls).toEqual(['BEGIN', 'UPDATE ngn_withdrawals SET', 'INSERT INTO ngn_ledger_entries', 'COMMIT'])
  })

  it('guards the update by status, so a repeat changes and writes nothing', async () => {
    const { calls, client } = fakePool((sql) =>
      sql.startsWith('UPDATE') ? { rows: [] } : { rows: [row({ status: 'rejected' })] },
    )

    const result = await new PostgresNgnWithdrawalStore().transition('a', {
      from: ['pending'],
      to: 'rejected',
      ledger: ledger('a', 'WITHDRAWAL_FAILED', 5_000),
    })

    expect(result).toMatchObject({ changed: false, record: { status: 'rejected' } })
    expect(calls.some((c) => c.startsWith('INSERT'))).toBe(false)
    const update = client.query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE'))!
    expect(update[0]).toContain('status = ANY($3::text[])')
    expect(update[1]).toContain('rejected')
    expect(update[1]![2]).toEqual(['pending'])
  })

  it('rolls everything back when the ledger entry cannot be written', async () => {
    const { calls } = fakePool((sql) => {
      if (sql.startsWith('UPDATE')) return { rows: [row({ status: 'rejected' })] }
      if (sql.includes('INSERT INTO ngn_ledger_entries')) return new Error('ledger insert failed')
      return { rows: [] }
    })

    await expect(
      new PostgresNgnWithdrawalStore().transition('a', {
        from: ['pending'],
        to: 'rejected',
        ledger: ledger('a', 'WITHDRAWAL_FAILED', 5_000),
      }),
    ).rejects.toThrow('ledger insert failed')

    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
  })

  it('creates the withdrawal and its reservation in one transaction, and rolls back on failure', async () => {
    const ok = fakePool((sql) => (sql.includes('INSERT INTO ngn_withdrawals') ? { rows: [row()] } : { rows: [] }))
    const created = await new PostgresNgnWithdrawalStore().createWithReservation(
      base('a'),
      ledger('a', 'WITHDRAWAL_PENDING', -5_000),
    )
    expect(created).toMatchObject({ id: 'a', status: 'pending', createdAt: new Date('2026-10-20T10:00:00.000Z') })
    expect(ok.calls).toEqual(['BEGIN', 'INSERT INTO ngn_ledger_entries', 'INSERT INTO ngn_withdrawals', 'COMMIT'])

    const bad = fakePool((sql) => (sql.includes('INSERT INTO ngn_withdrawals') ? new Error('duplicate') : { rows: [] }))
    await expect(
      new PostgresNgnWithdrawalStore().createWithReservation(base('a'), ledger('a', 'WITHDRAWAL_PENDING', -5_000)),
    ).rejects.toThrow('duplicate')
    expect(bad.calls).toContain('ROLLBACK')
  })

  it('reads a withdrawal back as a record (what survives a restart)', async () => {
    fakePool(() => ({ rows: [row({ status: 'approved', approved_by: 'admin-1', approved_at: '2026-10-20T11:00:00.000Z' })] }))

    const record = await new PostgresNgnWithdrawalStore().getById('a')

    expect(record).toMatchObject({
      id: 'a',
      status: 'approved',
      approvedBy: 'admin-1',
      amountNgn: 5000,
      bankAccount: { accountNumber: '0123456789' },
    })
  })

  it('pages with a keyset cursor and reports whether there is a next page', async () => {
    const rows = [row({ id: 'c' }), row({ id: 'b' }), row({ id: 'a' })]
    const { client } = fakePool(() => ({ rows }))

    const page = await new PostgresNgnWithdrawalStore().list({ status: 'pending', limit: 2 })

    expect(page.items.map((r) => r.id)).toEqual(['c', 'b'])
    expect(page.nextCursor).not.toBeNull()
    const [sql, params] = client.query.mock.calls[0]
    expect(sql).toContain('ORDER BY created_at DESC, id DESC')
    expect(params).toEqual(['pending', 3])
  })
})
