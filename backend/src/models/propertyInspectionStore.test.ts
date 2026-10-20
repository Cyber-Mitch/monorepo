import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setPool, type PgClientLike, type PgPoolLike } from '../db.js'
import {
  InMemoryPropertyInspectionStore,
  PostgresPropertyInspectionStore,
  type ListingTrustWriter,
} from './propertyInspectionStore.js'
import { INSPECTION_CATEGORIES } from '../services/inspectionTrustScore.js'

const fullChecklist = INSPECTION_CATEGORIES.map((category) => ({
  category,
  item: `${category} item`,
  result: 'pass' as const,
}))

async function submittedInMemory(listings: ListingTrustWriter) {
  const store = new InMemoryPropertyInspectionStore(listings)
  const inspection = await store.create({
    listingId: randomUUID(),
    inspectorId: 'inspector-1',
    scheduledAt: new Date(),
  })
  await store.transition(inspection.id, 'pending', 'in_progress')
  await store.upsertChecklistItems(inspection.id, fullChecklist)
  for (let i = 0; i < 3; i++) {
    await store.addPhoto(inspection.id, { url: `inspection-reports/${inspection.id}/${i}.jpg` })
  }
  const submitted = await store.submit(inspection.id)
  expect(submitted.ok).toBe(true)
  return { store, inspection }
}

describe('InMemoryPropertyInspectionStore.approve', () => {
  it('updates the listing and the inspection together', async () => {
    const updateTrustScore = vi.fn(async () => ({}))
    const { store, inspection } = await submittedInMemory({ updateTrustScore })

    const result = await store.approve(inspection.id, 'admin-1')

    expect(result).toMatchObject({ ok: true, trustScore: 100 })
    expect(updateTrustScore).toHaveBeenCalledWith(inspection.listingId, 100, true)
    expect((await store.findById(inspection.id))?.status).toBe('approved')
  })

  it('rolls the inspection back when the listing does not exist', async () => {
    const { store, inspection } = await submittedInMemory({
      updateTrustScore: vi.fn(async () => null),
    })

    const result = await store.approve(inspection.id, 'admin-1')

    expect(result).toEqual({ ok: false, reason: 'listing_not_found' })
    const after = await store.findById(inspection.id)
    expect(after?.status).toBe('submitted')
    expect(after?.approvedAt).toBeUndefined()
    expect(after?.reviewedBy).toBeUndefined()
  })

  it('rolls the inspection back when the listing write throws', async () => {
    const { store, inspection } = await submittedInMemory({
      updateTrustScore: vi.fn(async () => {
        throw new Error('boom')
      }),
    })

    await expect(store.approve(inspection.id, 'admin-1')).rejects.toThrow('boom')
    expect((await store.findById(inspection.id))?.status).toBe('submitted')
  })
})

describe('PostgresPropertyInspectionStore.approve', () => {
  afterEach(() => setPool(null))

  function fakePool(opts: { listingExists: boolean }) {
    const statements: string[] = []
    const inspectionId = randomUUID()
    const listingId = randomUUID()
    const row = {
      id: inspectionId,
      listing_id: listingId,
      inspector_id: 'inspector-1',
      status: 'submitted',
      created_at: new Date(),
      updated_at: new Date(),
    }
    const client: PgClientLike = {
      query: vi.fn(async (text: string) => {
        const sql = text.replace(/\s+/g, ' ').trim()
        statements.push(sql)
        if (sql.startsWith('SELECT') && sql.includes('FOR UPDATE')) {
          return { rows: [row], rowCount: 1 }
        }
        if (sql.startsWith('SELECT category, result')) {
          const rows = [
            { category: 'structural', result: 'pass' },
            { category: 'safety', result: 'fail' },
          ]
          return { rows, rowCount: rows.length }
        }
        if (sql.startsWith('UPDATE property_inspections')) {
          return { rows: [{ ...row, status: 'approved', approved_at: new Date() }], rowCount: 1 }
        }
        if (sql.startsWith('UPDATE whistleblower_listings')) {
          return opts.listingExists
            ? { rows: [{ listing_id: listingId }], rowCount: 1 }
            : { rows: [], rowCount: 0 }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool: PgPoolLike = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(async () => client),
    }
    return { pool, client, statements, inspectionId, listingId }
  }

  it('updates inspection and listing inside one transaction', async () => {
    const { pool, client, statements, inspectionId, listingId } = fakePool({ listingExists: true })
    setPool(pool)

    const result = await new PostgresPropertyInspectionStore().approve(inspectionId, 'admin-1')

    // structural pass (3) + safety fail (3) -> 50, below the safety cap
    expect(result).toMatchObject({ ok: true, trustScore: 50 })
    expect(statements[0]).toBe('BEGIN')
    expect(statements[statements.length - 1]).toBe('COMMIT')
    const listingUpdate = statements.findIndex((s) => s.startsWith('UPDATE whistleblower_listings'))
    const inspectionUpdate = statements.findIndex((s) => s.startsWith('UPDATE property_inspections'))
    expect(listingUpdate).toBeGreaterThan(0)
    expect(inspectionUpdate).toBeGreaterThan(0)
    expect(statements[listingUpdate]).toContain('has_verified_inspection = TRUE')
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE whistleblower_listings'),
      [listingId, 50],
    )
    expect(client.release).toHaveBeenCalled()
  })

  it('rolls back when the listing row is missing', async () => {
    const { pool, statements, inspectionId } = fakePool({ listingExists: false })
    setPool(pool)

    const result = await new PostgresPropertyInspectionStore().approve(inspectionId, 'admin-1')

    expect(result).toEqual({ ok: false, reason: 'listing_not_found' })
    expect(statements).toContain('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
  })
})
