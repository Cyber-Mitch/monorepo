import { describe, expect, it, vi } from 'vitest'
import { xdr } from '@stellar/stellar-sdk'
import {
  SorobanEventIndexer,
  computeBackoffDelayMs,
  decodeRpcEvent,
  toJsonValue,
} from './sorobanEventIndexer.js'

const CONTRACT = 'CONTRACT_A'
const PAGE_LIMIT = 200

function fakeEvent(id: string, ledger: number): any {
  return {
    id,
    ledger,
    txHash: `tx-${id}`,
    type: 'contract',
    contractId: { toString: () => CONTRACT },
    topic: [xdr.ScVal.scvSymbol('Ping')],
    value: xdr.ScVal.scvVoid(),
    inSuccessfulContractCall: true,
  }
}

function page(events: any[], cursor: string, latestLedger: number): any {
  return {
    events,
    cursor,
    latestLedger,
    oldestLedger: 1,
    latestLedgerCloseTime: '',
    oldestLedgerCloseTime: '',
  }
}

/** Fake Postgres: `savedLedger` is what indexer_state holds; every statement is logged. */
function fakeDb(savedLedger: number) {
  const statements: Array<{ sql: string; params?: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params })
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params })
      const rows = sql.includes('SELECT last_ledger_sequence')
        ? [{ last_ledger_sequence: String(savedLedger) }]
        : []
      return { rows, rowCount: rows.length }
    }),
    connect: vi.fn(async () => client),
  }
  return { pool, statements }
}

function indexerWith(rpc: unknown, pool: unknown): SorobanEventIndexer {
  const indexer = new SorobanEventIndexer({
    rpc: rpc as any,
    getPool: async () => pool as any,
    getContractIds: () => [CONTRACT],
    pollIntervalMs: 60_000,
  })
  // poll() only runs while the indexer is running. Set the flag without starting timers.
  ;(indexer as any).isRunning = true
  return indexer
}

describe('SorobanEventIndexer sync', () => {
  it('resumes from the saved ledger cursor', async () => {
    const { pool } = fakeDb(120)
    const rpc = {
      getLatestLedger: vi.fn(),
      getEvents: vi.fn(async () => page([], '', 125)),
    }

    await (indexerWith(rpc, pool) as any).poll()

    expect(rpc.getEvents).toHaveBeenCalledWith({
      filters: [{ type: 'contract', contractIds: [CONTRACT] }],
      startLedger: 121,
      limit: PAGE_LIMIT,
    })
    expect(rpc.getLatestLedger).not.toHaveBeenCalled()
  })

  it('starts from the current ledger when the contract has never been indexed', async () => {
    const { pool } = fakeDb(0)
    const rpc = {
      getLatestLedger: vi.fn(async () => ({ sequence: 500 })),
      getEvents: vi.fn(async () => page([], '', 500)),
    }

    await (indexerWith(rpc, pool) as any).poll()

    expect(rpc.getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 500 }))
  })

  it('pages with the cursor until a short page, then advances state to latestLedger', async () => {
    const { pool, statements } = fakeDb(120)
    const full = Array.from({ length: PAGE_LIMIT }, (_, i) => fakeEvent(`e${i}`, 130))
    const rpc = {
      getLatestLedger: vi.fn(),
      getEvents: vi
        .fn()
        .mockResolvedValueOnce(page(full, 'cursor-200', 140))
        .mockResolvedValueOnce(page([fakeEvent('e200', 131)], 'cursor-201', 140)),
    }

    await (indexerWith(rpc, pool) as any).poll()

    expect(rpc.getEvents).toHaveBeenNthCalledWith(2, {
      filters: [{ type: 'contract', contractIds: [CONTRACT] }],
      cursor: 'cursor-200',
      limit: PAGE_LIMIT,
    })

    const inserts = statements.filter((s) => s.sql.includes('INSERT INTO indexed_contract_events'))
    expect(inserts).toHaveLength(PAGE_LIMIT + 1)

    const stateUpdates = statements.filter((s) => s.sql.includes('UPDATE indexer_state'))
    expect(stateUpdates.at(-1)?.params).toEqual([CONTRACT, 140])
  })

  it('stores each page and its cursor update in one transaction', async () => {
    const { pool, statements } = fakeDb(120)
    const rpc = {
      getLatestLedger: vi.fn(),
      getEvents: vi.fn(async () => page([fakeEvent('e1', 121)], '', 121)),
    }

    await (indexerWith(rpc, pool) as any).poll()

    const sql = statements.map((s) => s.sql)
    const begin = sql.indexOf('BEGIN')
    const commit = sql.indexOf('COMMIT')
    expect(begin).toBeGreaterThanOrEqual(0)
    expect(commit).toBeGreaterThan(begin)
    expect(sql.slice(begin, commit).some((s) => s.includes('INSERT INTO indexed_contract_events'))).toBe(true)
    expect(sql.slice(begin, commit).some((s) => s.includes('UPDATE indexer_state'))).toBe(true)
  })

  it('keys stored events on the Soroban event id so replayed pages are ignored', async () => {
    const { pool, statements } = fakeDb(120)
    const rpc = {
      getLatestLedger: vi.fn(),
      getEvents: vi.fn(async () => page([fakeEvent('evt-9', 121)], '', 121)),
    }

    await (indexerWith(rpc, pool) as any).poll()

    const insert = statements.find((s) => s.sql.includes('INSERT INTO indexed_contract_events'))
    expect(insert?.sql).toContain('ON CONFLICT (contract_id, event_id) DO NOTHING')
    expect(insert?.params?.[0]).toBe('evt-9')
  })

  it('reports failure when the RPC errors, so the caller backs off', async () => {
    const { pool } = fakeDb(120)
    const rpc = {
      getLatestLedger: vi.fn(),
      getEvents: vi.fn(async () => {
        throw new Error('rpc down')
      }),
    }

    await expect((indexerWith(rpc, pool) as any).poll()).resolves.toBe(false)
  })
})

describe('computeBackoffDelayMs', () => {
  it('doubles the delay per consecutive failure and caps it', () => {
    expect(computeBackoffDelayMs(5000, 1)).toBe(10_000)
    expect(computeBackoffDelayMs(5000, 2)).toBe(20_000)
    expect(computeBackoffDelayMs(5000, 40)).toBe(5 * 60 * 1000)
  })
})

describe('decoding', () => {
  it('turns bigints, maps and void values into stable JSON', () => {
    expect(toJsonValue({ amount: 10n, tags: new Map([['k', 2n]]) })).toEqual({
      amount: '10',
      tags: { k: '2' },
    })
    expect(toJsonValue(undefined)).toBeNull()
  })

  it('decodes an RPC event into the stored event shape with its event id', () => {
    const decoded = decodeRpcEvent(fakeEvent('evt-1', 77) as any)

    expect(decoded).toMatchObject({
      eventId: 'evt-1',
      contractId: CONTRACT,
      ledgerSequence: 77,
      transactionHash: 'tx-evt-1',
      eventType: 'Ping',
    })
  })
})
