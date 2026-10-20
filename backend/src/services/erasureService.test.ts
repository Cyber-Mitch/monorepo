import { describe, it, expect, beforeEach, vi } from 'vitest'
import { erasureService } from './erasureService.js'
import * as dbModule from '../db.js'

describe('ErasureService Cascade', () => {
  let queryMock: ReturnType<typeof vi.fn>
  let poolMock: { query: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    queryMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM erasure_requests')) {
        return { rows: [] }
      }
      if (sql.includes('SELECT * FROM erasure_requests WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'req-1',
              user_id: 'user-123',
              status: 'pending',
              requested_at: new Date().toISOString(),
              confirm_by: new Date(Date.now() + 86400000).toISOString(),
              confirmed_at: null,
              confirmed_by: null,
            },
          ],
        }
      }
      if (sql.includes('SELECT email FROM users')) {
        return { rows: [{ email: 'user@example.com' }] }
      }
      return { rows: [], rowCount: 1 }
    })

    poolMock = { query: queryMock }
    vi.spyOn(dbModule, 'getPool').mockResolvedValue(poolMock as any)
  })

  it('confirms erasure and cascades across all PII tables in transaction', async () => {
    await erasureService.confirmErasure('req-1', 'admin-1')

    const queries = queryMock.mock.calls.map((c) => c[0])

    expect(queries).toContain('BEGIN')
    expect(queries).toContain('COMMIT')

    // Verify all covered tables are updated
    const fullSql = queries.join(' ')
    expect(fullSql).toContain('UPDATE users SET')
    expect(fullSql).toContain('UPDATE landlord_profiles SET')
    expect(fullSql).toContain('UPDATE onboarding_drafts SET')
    expect(fullSql).toContain('UPDATE kyc_documents SET')
    expect(fullSql).toContain('UPDATE messages SET')
    expect(fullSql).toContain('UPDATE tenant_documents SET')
    expect(fullSql).toContain('UPDATE support_messages SET')
    expect(fullSql).toContain('UPDATE notifications SET')
    expect(fullSql).toContain('UPDATE apartment_reviews SET')
    expect(fullSql).toContain('UPDATE sessions SET')
    expect(fullSql).toContain('UPDATE erasure_requests SET')
  })

  it('rolls back transaction if an error occurs during cascade', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE messages SET')) {
        throw new Error('DB error')
      }
      if (sql.includes('SELECT id FROM erasure_requests')) {
        return { rows: [] }
      }
      if (sql.includes('SELECT * FROM erasure_requests WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'req-1',
              user_id: 'user-123',
              status: 'pending',
              requested_at: new Date().toISOString(),
              confirm_by: new Date(Date.now() + 86400000).toISOString(),
              confirmed_at: null,
              confirmed_by: null,
            },
          ],
        }
      }
      return { rows: [] }
    })

    await expect(erasureService.confirmErasure('req-1', 'admin-1')).rejects.toThrow('DB error')

    const queries = queryMock.mock.calls.map((c) => c[0])
    expect(queries).toContain('BEGIN')
    expect(queries).toContain('ROLLBACK')
    expect(queries).not.toContain('COMMIT')
  })
})

describe('ErasureService request lifecycle (Postgres store)', () => {
  const pendingRow = {
    id: 'req-1',
    user_id: 'user-123',
    status: 'pending',
    requested_at: new Date().toISOString(),
    confirm_by: new Date(Date.now() + 86400000).toISOString(),
    confirmed_at: null,
    confirmed_by: null,
  }

  function mockPool(impl: (sql: string, params?: unknown[]) => unknown) {
    const query = vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => impl(sql, params))
    vi.spyOn(dbModule, 'getPool').mockResolvedValue({ query } as any)
    return query
  }

  it('maps a unique violation on insert to ERASURE_ALREADY_PENDING', async () => {
    mockPool((sql) => {
      if (sql.includes('SELECT id FROM erasure_requests')) return { rows: [] }
      if (sql.includes('INSERT INTO erasure_requests')) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' })
      }
      return { rows: [] }
    })

    await expect(erasureService.requestErasure('user-123')).rejects.toThrow('ERASURE_ALREADY_PENDING')
  })

  it('cancels only pending requests', async () => {
    const query = mockPool((sql) =>
      sql.includes("SET status = 'cancelled'") ? { rows: [{ ...pendingRow, status: 'cancelled' }] } : { rows: [] },
    )

    const cancelled = await erasureService.cancelErasure('req-1')
    expect(cancelled?.status).toBe('cancelled')
    const sql = query.mock.calls[0][0] as string
    expect(sql).toContain("WHERE id = $1 AND status = 'pending'")
  })

  it('returns null when there is nothing pending to cancel', async () => {
    mockPool(() => ({ rows: [] }))
    expect(await erasureService.cancelErasure('req-1')).toBeNull()
  })

  it('lists requests filtered by status with a total', async () => {
    const query = mockPool((sql) =>
      sql.includes('COUNT(*)') ? { rows: [{ total: 1 }] } : { rows: [pendingRow] },
    )

    const result = await erasureService.list({ status: 'pending', limit: 10, offset: 0 })
    expect(result.total).toBe(1)
    expect(result.requests[0]).toMatchObject({ id: 'req-1', userId: 'user-123', status: 'pending' })
    expect(query.mock.calls[0][1]).toEqual(['pending', 10, 0])
  })

  it('returns the expired count from expireOverdueRequests', async () => {
    mockPool(() => ({ rows: [{ id: 'req-1', user_id: 'user-123' }], rowCount: 1 }))
    expect(await erasureService.expireOverdueRequests(new Date())).toBe(1)
  })
})
