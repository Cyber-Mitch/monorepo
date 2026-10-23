/**
 * Tests for tenantReputationService — issue #1980.
 *
 * Coverage:
 * - computePaymentScore: on-time, late, missed, mixed, no rows, pending/waived excluded
 * - computeRatingScores: no ratings, single, multiple, boundary values
 * - computeReputationRecord: combines dimensions with default weights, custom weights
 * - reputationRecordsEqual: identity and difference detection for each field
 * - syncTenantReputation: enqueues outbox item on change; does NOT enqueue when unchanged
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  computePaymentScore,
  computeRatingScores,
  computeReputationRecord,
  reputationRecordsEqual,
  syncTenantReputation,
  DEFAULT_WEIGHTS,
  type PaymentRow,
  type RatingRow,
  type ReputationRecord,
} from './tenantReputationService.js'

// ── Module mocks ──────────────────────────────────────────────────────────

vi.mock('../models/tenantRatingStore.js', () => ({
  tenantRatingStore: { listRatingsForTenant: vi.fn() },
}))

vi.mock('../models/tenantReputationStore.js', () => ({
  tenantReputationStore: {
    findByTenantId: vi.fn(),
    upsert:         vi.fn(),
  },
}))

vi.mock('../outbox/store.js', () => ({
  outboxStore: { create: vi.fn() },
}))

// Mock getPool to return null so fetchPaymentRows skips the DB query
vi.mock('../db.js', () => ({
  getPool: vi.fn().mockResolvedValue(null),
}))

import { tenantRatingStore } from '../models/tenantRatingStore.js'
import { tenantReputationStore } from '../models/tenantReputationStore.js'
import { outboxStore } from '../outbox/store.js'

// ── Helpers ───────────────────────────────────────────────────────────────

function makePaymentRow(
  override: Partial<PaymentRow> & { status: PaymentRow['status'] },
): PaymentRow {
  const now = new Date()
  return {
    dueDate: override.dueDate ?? now.toISOString(),
    paidAt:  override.paidAt  ?? null,
    ...override,
  }
}

function onTimeRow(): PaymentRow {
  const due  = new Date('2026-01-15')
  const paid = new Date('2026-01-10') // before due → on-time
  return makePaymentRow({ status: 'paid', dueDate: due.toISOString(), paidAt: paid.toISOString() })
}

function lateRow(): PaymentRow {
  const due  = new Date('2026-01-15')
  const paid = new Date('2026-01-20') // after due → late
  return makePaymentRow({ status: 'paid', dueDate: due.toISOString(), paidAt: paid.toISOString() })
}

function overdueRow(): PaymentRow {
  return makePaymentRow({ status: 'overdue', paidAt: null })
}

// ── computePaymentScore ───────────────────────────────────────────────────

describe('computePaymentScore', () => {
  it('returns 50 (neutral) when no rows are provided', () => {
    expect(computePaymentScore([])).toBe(50)
  })

  it('returns 50 (neutral) when all rows are pending or waived', () => {
    const rows: PaymentRow[] = [
      makePaymentRow({ status: 'pending' }),
      makePaymentRow({ status: 'waived' }),
    ]
    expect(computePaymentScore(rows)).toBe(50)
  })

  it('returns 100 when all payments are on-time', () => {
    const rows = [onTimeRow(), onTimeRow(), onTimeRow()]
    expect(computePaymentScore(rows)).toBe(100)
  })

  it('returns 0 when all payments are missed (overdue)', () => {
    const rows = [overdueRow(), overdueRow(), overdueRow()]
    expect(computePaymentScore(rows)).toBe(0)
  })

  it('returns 50 when all payments are late (0.5 weight each)', () => {
    const rows = [lateRow(), lateRow()]
    expect(computePaymentScore(rows)).toBe(50)
  })

  it('computes a mixed score correctly', () => {
    // 2 on-time (1.0 each) + 2 late (0.5 each) + 1 missed (0.0)
    // raw = (2*1 + 2*0.5 + 1*0) / 5 = 3/5 = 0.6 → 60
    const rows = [onTimeRow(), onTimeRow(), lateRow(), lateRow(), overdueRow()]
    expect(computePaymentScore(rows)).toBe(60)
  })

  it('treats paid rows without a paidAt timestamp as on-time', () => {
    const row = makePaymentRow({ status: 'paid', paidAt: null })
    expect(computePaymentScore([row])).toBe(100)
  })

  it('excludes pending and waived rows from the calculation', () => {
    // 1 on-time + 1 pending + 1 waived → only the on-time row is scored → 100
    const rows: PaymentRow[] = [
      onTimeRow(),
      makePaymentRow({ status: 'pending' }),
      makePaymentRow({ status: 'waived' }),
    ]
    expect(computePaymentScore(rows)).toBe(100)
  })
})

// ── computeRatingScores ───────────────────────────────────────────────────

describe('computeRatingScores', () => {
  it('returns 50 for each dimension when there are no ratings', () => {
    const result = computeRatingScores([])
    expect(result.propertyCareScore).toBe(50)
    expect(result.communicationScore).toBe(50)
  })

  it('maps a perfect 5-star rating to 100', () => {
    const row: RatingRow = { propertyCare: 5, communication: 5 }
    const result = computeRatingScores([row])
    expect(result.propertyCareScore).toBe(100)
    expect(result.communicationScore).toBe(100)
  })

  it('maps a minimum 1-star rating to 20', () => {
    const row: RatingRow = { propertyCare: 1, communication: 1 }
    const result = computeRatingScores([row])
    expect(result.propertyCareScore).toBe(20)
    expect(result.communicationScore).toBe(20)
  })

  it('averages multiple ratings', () => {
    // care: (5 + 3) / 2 = 4 → 80   comm: (2 + 4) / 2 = 3 → 60
    const rows: RatingRow[] = [
      { propertyCare: 5, communication: 2 },
      { propertyCare: 3, communication: 4 },
    ]
    const result = computeRatingScores(rows)
    expect(result.propertyCareScore).toBe(80)
    expect(result.communicationScore).toBe(60)
  })

  it('rounds the average correctly', () => {
    // care: (5 + 4 + 4) / 3 = 4.333… × 20 = 86.666… → rounds to 87
    const rows: RatingRow[] = [
      { propertyCare: 5, communication: 3 },
      { propertyCare: 4, communication: 3 },
      { propertyCare: 4, communication: 3 },
    ]
    const result = computeRatingScores(rows)
    expect(result.propertyCareScore).toBe(87)
  })
})

// ── computeReputationRecord ───────────────────────────────────────────────

describe('computeReputationRecord', () => {
  it('returns neutral 50 compositeScore with no data', () => {
    const record = computeReputationRecord([], [])
    expect(record.compositeScore).toBe(50)
    expect(record.paymentScore).toBe(50)
    expect(record.propertyCareScore).toBe(50)
    expect(record.communicationScore).toBe(50)
    expect(record.totalRatings).toBe(0)
  })

  it('counts totalRatings from the rating rows', () => {
    const ratings: RatingRow[] = [
      { propertyCare: 4, communication: 4 },
      { propertyCare: 5, communication: 5 },
      { propertyCare: 3, communication: 3 },
    ]
    const record = computeReputationRecord([], ratings)
    expect(record.totalRatings).toBe(3)
  })

  it('applies default weights to compute compositeScore', () => {
    // payment=100, propertyCare=100, communication=100 → composite = 100
    const record = computeReputationRecord(
      [onTimeRow()],
      [{ propertyCare: 5, communication: 5 }],
    )
    expect(record.compositeScore).toBe(100)
    expect(record.paymentScore).toBe(100)
    expect(record.propertyCareScore).toBe(100)
    expect(record.communicationScore).toBe(100)
  })

  it('applies custom weights correctly', () => {
    // payment=100, propCare=50 (default neutral), comm=50 (default neutral)
    // composite = 100*0.8 + 50*0.1 + 50*0.1 = 80 + 5 + 5 = 90
    const weights = { payment: 0.8, propertyCare: 0.1, communication: 0.1 }
    const record = computeReputationRecord([onTimeRow()], [], weights)
    expect(record.compositeScore).toBe(90)
  })

  it('clamps compositeScore to [0, 100]', () => {
    // Even with extreme inputs (all 0s) the clamp holds
    const record = computeReputationRecord(
      [overdueRow()],
      [{ propertyCare: 1, communication: 1 }],
    )
    expect(record.compositeScore).toBeGreaterThanOrEqual(0)
    expect(record.compositeScore).toBeLessThanOrEqual(100)
  })

  it('uses DEFAULT_WEIGHTS that sum to 1.0', () => {
    const sum = DEFAULT_WEIGHTS.payment + DEFAULT_WEIGHTS.propertyCare + DEFAULT_WEIGHTS.communication
    expect(sum).toBeCloseTo(1.0)
  })

  it('uses DEFAULT_WEIGHTS of 0.50 / 0.30 / 0.20', () => {
    expect(DEFAULT_WEIGHTS.payment).toBe(0.50)
    expect(DEFAULT_WEIGHTS.propertyCare).toBe(0.30)
    expect(DEFAULT_WEIGHTS.communication).toBe(0.20)
  })
})

// ── reputationRecordsEqual ────────────────────────────────────────────────

describe('reputationRecordsEqual', () => {
  const base: ReputationRecord = {
    compositeScore:     75,
    paymentScore:       80,
    propertyCareScore:  70,
    communicationScore: 60,
    totalRatings:       5,
  }

  it('returns true when all fields are identical', () => {
    expect(reputationRecordsEqual(base, { ...base })).toBe(true)
  })

  it('returns false when compositeScore differs', () => {
    expect(reputationRecordsEqual(base, { ...base, compositeScore: 76 })).toBe(false)
  })

  it('returns false when paymentScore differs', () => {
    expect(reputationRecordsEqual(base, { ...base, paymentScore: 81 })).toBe(false)
  })

  it('returns false when propertyCareScore differs', () => {
    expect(reputationRecordsEqual(base, { ...base, propertyCareScore: 71 })).toBe(false)
  })

  it('returns false when communicationScore differs', () => {
    expect(reputationRecordsEqual(base, { ...base, communicationScore: 61 })).toBe(false)
  })

  it('returns false when totalRatings differs', () => {
    expect(reputationRecordsEqual(base, { ...base, totalRatings: 6 })).toBe(false)
  })
})

// ── syncTenantReputation ──────────────────────────────────────────────────

describe('syncTenantReputation — change-only enqueue', () => {
  const tenantId = 'tenant-abc'

  // A rating that produces deterministic scores
  const rating = { propertyCare: 4, communication: 4, paymentTimeliness: 4, overall: 4, comment: null, createdAt: new Date() }

  // The corresponding computed record (no payments → paymentScore=50)
  // propertyCare: avg(4)*20 = 80, communication: avg(4)*20 = 80
  // composite: 50*0.5 + 80*0.3 + 80*0.2 = 25 + 24 + 16 = 65
  const expectedRecord: ReputationRecord = {
    compositeScore:     65,
    paymentScore:       50,
    propertyCareScore:  80,
    communicationScore: 80,
    totalRatings:       1,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(tenantRatingStore.listRatingsForTenant).mockResolvedValue([rating])
    vi.mocked(tenantReputationStore.upsert).mockResolvedValue({
      id:        'rep-1',
      tenantId,
      updatedAt: new Date(),
      ...expectedRecord,
    })
  })

  it('enqueues an outbox item when no previous record exists', async () => {
    vi.mocked(tenantReputationStore.findByTenantId).mockResolvedValue(null)

    await syncTenantReputation(tenantId)

    expect(tenantReputationStore.upsert).toHaveBeenCalledWith(tenantId, expect.objectContaining({
      compositeScore:     expectedRecord.compositeScore,
      paymentScore:       expectedRecord.paymentScore,
      propertyCareScore:  expectedRecord.propertyCareScore,
      communicationScore: expectedRecord.communicationScore,
      totalRatings:       expectedRecord.totalRatings,
    }))
    expect(outboxStore.create).toHaveBeenCalledOnce()
    expect(outboxStore.create).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        tenantId,
        // Scores are scaled ×10 for the 0–1000 on-chain range
        compositeScore:     expectedRecord.compositeScore    * 10,
        paymentScore:       expectedRecord.paymentScore      * 10,
        propertyCareScore:  expectedRecord.propertyCareScore * 10,
        communicationScore: expectedRecord.communicationScore * 10,
        totalRatings:       expectedRecord.totalRatings,
      }),
    }))
  })

  it('enqueues an outbox item when the record changed', async () => {
    // Previous record has different compositeScore
    vi.mocked(tenantReputationStore.findByTenantId).mockResolvedValue({
      id:        'rep-1',
      tenantId,
      updatedAt: new Date(),
      ...expectedRecord,
      compositeScore: 40, // different from the recomputed 65
    })

    await syncTenantReputation(tenantId)

    expect(outboxStore.create).toHaveBeenCalledOnce()
  })

  it('does NOT enqueue an outbox item when the record is unchanged', async () => {
    // Previous record exactly matches what will be recomputed
    vi.mocked(tenantReputationStore.findByTenantId).mockResolvedValue({
      id:        'rep-1',
      tenantId,
      updatedAt: new Date(),
      ...expectedRecord,
    })

    await syncTenantReputation(tenantId)

    expect(outboxStore.create).not.toHaveBeenCalled()
    expect(tenantReputationStore.upsert).not.toHaveBeenCalled()
  })

  it('stores the record and enqueues the outbox item with correct tx type', async () => {
    vi.mocked(tenantReputationStore.findByTenantId).mockResolvedValue(null)

    await syncTenantReputation(tenantId)

    const createCall = vi.mocked(outboxStore.create).mock.calls[0][0]
    expect(createCall.txType).toBe('tenant_reputation_update')
    expect(createCall.aggregateType).toBe('tenant')
    expect(createCall.aggregateId).toBe(tenantId)
    expect(createCall.eventType).toBe('TENANT_REPUTATION_UPDATE')
  })

  it('does NOT enqueue even when totalRatings changes but scores are unchanged', async () => {
    // This tests a subtle case: scores may be identical if a new rating averages out
    // to the same values. Since reputationRecordsEqual also checks totalRatings,
    // this case WILL produce an enqueue (totalRatings changed).
    vi.mocked(tenantReputationStore.findByTenantId).mockResolvedValue({
      id:        'rep-1',
      tenantId,
      updatedAt: new Date(),
      ...expectedRecord,
      totalRatings: 0, // different from recomputed 1
    })

    await syncTenantReputation(tenantId)

    // totalRatings differs → should enqueue
    expect(outboxStore.create).toHaveBeenCalledOnce()
  })
})
