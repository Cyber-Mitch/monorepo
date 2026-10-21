/**
 * Tenant reputation service — issue #1980.
 *
 * Computes composite and per-dimension reputation scores from landlord ratings
 * and payment history, then enqueues a TENANT_REPUTATION_UPDATE outbox item
 * when (and only when) the computed record differs from the last published one.
 *
 * ## Score dimensions
 *
 * All output scores are on the **0–100** scale used by the Soroban contract
 * (TenantReputationRecord.{composite,payment,propertyCare,communication}Score).
 * The contract stores them as u32; 0–100 maps cleanly to percentages and
 * matches what `sender.ts` multiplies by 10 for the 0–1000 on-chain encoding.
 *
 * ### paymentScore (0–100)
 * Derived from the tenant's `repayment_schedule` rows across all deals:
 * - Each `paid` row on or before its due_date counts as on-time.
 * - Each `paid` row after its due_date counts as late.
 * - Each `overdue` row counts as missed.
 * - `pending` and `waived` rows are excluded (not yet due / written off).
 *
 * Formula:
 *   onTimeWeight  = 1.0
 *   lateWeight    = 0.5
 *   missedWeight  = 0.0
 *   rawScore = (onTime * onTimeWeight + late * lateWeight) / (onTime + late + missed)
 *   paymentScore = Math.round(rawScore * 100)   clamped [0, 100]
 *
 * With zero scoreable rows → paymentScore defaults to 50 (neutral).
 *
 * ### propertyCareScore and communicationScore (0–100)
 * Derived from `tenant_ratings` rows (landlord ratings, 1–5 stars per dimension):
 *   propertyCareScore  = Math.round(avg(propertyCare) * 20)
 *   communicationScore = Math.round(avg(communication) * 20)
 *
 * With zero ratings → each defaults to 50 (neutral).
 *
 * ### compositeScore (0–100)
 * Weighted mean of the three components with documented weights:
 *   WEIGHT_PAYMENT       = 0.50  (payment behaviour is the strongest signal)
 *   WEIGHT_PROPERTY_CARE = 0.30
 *   WEIGHT_COMMUNICATION = 0.20
 *
 * All weights sum to 1.0. Override via `ScoringWeights` argument to
 * `computeReputationRecord` for future A/B testing or policy changes.
 *
 * ### totalRatings
 * Count of `tenant_ratings` rows for the tenant. Does not include payment data.
 *
 * ## Debounce / change-only enqueue
 * `syncTenantReputation` compares the newly computed record against the last
 * stored record in `tenant_reputation_scores`. No outbox item is enqueued
 * when all five values are identical.
 */

import { tenantRatingStore } from '../models/tenantRatingStore.js'
import { tenantReputationStore } from '../models/tenantReputationStore.js'
import { outboxStore } from '../outbox/store.js'
import { TxType } from '../outbox/types.js'
import { logger } from '../utils/logger.js'
import { getPool } from '../db.js'

// ── Scoring weights ────────────────────────────────────────────────────────

export interface ScoringWeights {
  /** 0–1, weight applied to paymentScore */
  payment: number
  /** 0–1, weight applied to propertyCareScore */
  propertyCare: number
  /** 0–1, weight applied to communicationScore */
  communication: number
}

/**
 * Default scoring weights. Sum must equal 1.0.
 *
 * Payment behaviour is given the highest weight because it is objective
 * (derived from verifiable on-chain/DB timestamps), whereas ratings carry
 * a degree of subjectivity.
 */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  payment:      0.50,
  propertyCare: 0.30,
  communication: 0.20,
}

// ── Input types ────────────────────────────────────────────────────────────

export interface PaymentRow {
  /** ISO datetime or Date for when the payment was due */
  dueDate: Date | string
  /** ISO datetime or Date for when payment was recorded; null if not paid */
  paidAt: Date | string | null
  status: 'pending' | 'paid' | 'overdue' | 'waived'
}

export interface RatingRow {
  propertyCare: number
  communication: number
}

// ── Output type ────────────────────────────────────────────────────────────

export interface ReputationRecord {
  /** Weighted composite of the three dimension scores. 0–100. */
  compositeScore: number
  /** Payment on-time rate converted to 0–100. */
  paymentScore: number
  /** Average propertyCare rating converted to 0–100. */
  propertyCareScore: number
  /** Average communication rating converted to 0–100. */
  communicationScore: number
  /** Count of landlord ratings received. */
  totalRatings: number
}

// ── Pure computation ───────────────────────────────────────────────────────

/** Clamp `value` to the range [lo, hi]. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

/**
 * Compute the paymentScore (0–100) from a set of repayment schedule rows.
 *
 * @param rows - Rows from `repayment_schedule`; pending/waived rows are ignored.
 * @returns Integer 0–100; 50 when there are no scoreable rows.
 */
export function computePaymentScore(rows: PaymentRow[]): number {
  const scoreable = rows.filter((r) => r.status === 'paid' || r.status === 'overdue')

  if (scoreable.length === 0) return 50 // neutral default

  let onTime = 0
  let late = 0
  let missed = 0

  for (const row of scoreable) {
    if (row.status === 'overdue') {
      missed++
      continue
    }
    // status === 'paid'
    if (row.paidAt == null) {
      // Defensive: treat paid-without-timestamp as on-time
      onTime++
      continue
    }
    const due = new Date(row.dueDate).getTime()
    const paid = new Date(row.paidAt).getTime()
    if (paid <= due) {
      onTime++
    } else {
      late++
    }
  }

  const total = onTime + late + missed
  if (total === 0) return 50

  // onTime=1.0, late=0.5, missed=0.0
  const raw = (onTime * 1.0 + late * 0.5) / total
  return clamp(Math.round(raw * 100), 0, 100)
}

/**
 * Compute propertyCareScore and communicationScore (0–100 each) from rating rows.
 *
 * Ratings are on a 1–5 scale. The conversion factor is ×20 so that a perfect
 * average of 5 maps to 100 and a minimum of 1 maps to 20.
 *
 * @returns Each score is an integer 0–100; 50 when there are no ratings.
 */
export function computeRatingScores(rows: RatingRow[]): {
  propertyCareScore: number
  communicationScore: number
} {
  if (rows.length === 0) {
    return { propertyCareScore: 50, communicationScore: 50 }
  }

  const sumCare = rows.reduce((s, r) => s + r.propertyCare, 0)
  const sumComm = rows.reduce((s, r) => s + r.communication, 0)
  const n = rows.length

  return {
    propertyCareScore:  clamp(Math.round((sumCare / n) * 20), 0, 100),
    communicationScore: clamp(Math.round((sumComm / n) * 20), 0, 100),
  }
}

/**
 * Compute the full reputation record from payment history and ratings.
 *
 * This is a **pure function** — it does not touch any store or outbox.
 * Call `syncTenantReputation` to persist the result and enqueue an outbox item.
 *
 * @param paymentRows  - Rows from `repayment_schedule` for the tenant's deals.
 * @param ratingRows   - Rows from `tenant_ratings` for the tenant.
 * @param weights      - Composite weight overrides (defaults to DEFAULT_WEIGHTS).
 */
export function computeReputationRecord(
  paymentRows: PaymentRow[],
  ratingRows: RatingRow[],
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): ReputationRecord {
  const paymentScore = computePaymentScore(paymentRows)
  const { propertyCareScore, communicationScore } = computeRatingScores(ratingRows)

  const composite =
    paymentScore      * weights.payment +
    propertyCareScore * weights.propertyCare +
    communicationScore * weights.communication

  return {
    compositeScore:     clamp(Math.round(composite), 0, 100),
    paymentScore,
    propertyCareScore,
    communicationScore,
    totalRatings: ratingRows.length,
  }
}

/** Returns true when two records are identical in every scored field. */
export function reputationRecordsEqual(
  a: ReputationRecord,
  b: ReputationRecord,
): boolean {
  return (
    a.compositeScore      === b.compositeScore &&
    a.paymentScore        === b.paymentScore &&
    a.propertyCareScore   === b.propertyCareScore &&
    a.communicationScore  === b.communicationScore &&
    a.totalRatings        === b.totalRatings
  )
}

// ── Pending debounce timers ────────────────────────────────────────────────

/**
 * Debounce map: tenantId → NodeJS timer handle.
 * Prevents a burst of events (e.g. 10 ratings imported at once) from
 * enqueueing 10 identical outbox items. The first event sets the timer;
 * subsequent ones reset it. The actual sync runs once, after the burst.
 */
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Default debounce delay in milliseconds. Exported for test overrides. */
export const DEFAULT_DEBOUNCE_MS = 2_000

/**
 * Schedule a debounced reputation sync for `tenantId`.
 *
 * If a timer is already pending for this tenant it is cancelled and replaced,
 * so the actual sync happens `debounceMs` after the **last** event in a burst.
 */
export function scheduleSyncTenantReputation(
  tenantId: string,
  debounceMs = DEFAULT_DEBOUNCE_MS,
): void {
  const existing = pendingTimers.get(tenantId)
  if (existing) clearTimeout(existing)

  const handle = setTimeout(() => {
    pendingTimers.delete(tenantId)
    syncTenantReputation(tenantId).catch((err) =>
      logger.error('Debounced tenant reputation sync failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }, debounceMs)

  pendingTimers.set(tenantId, handle)
}

// ── Data fetching ──────────────────────────────────────────────────────────

/**
 * Fetch all repayment schedule rows across all deals for a given tenant.
 * Falls back to an empty array when the DB is unavailable (in-memory mode).
 */
async function fetchPaymentRows(tenantId: string): Promise<PaymentRow[]> {
  const pool = await getPool()
  if (!pool) return []

  const { rows } = await pool.query<{
    due_date: string
    paid_at: string | null
    status: string
  }>(
    `SELECT rs.due_date, rs.paid_at, rs.status
     FROM repayment_schedule rs
     JOIN tenant_deals td ON td.deal_id = rs.deal_id
     WHERE td.tenant_id = $1
       AND rs.status IN ('paid', 'overdue')`,
    [tenantId],
  )

  return rows.map((r) => ({
    dueDate: r.due_date,
    paidAt: r.paid_at,
    status: r.status as PaymentRow['status'],
  }))
}

// ── Sync (orchestrator) ────────────────────────────────────────────────────

/**
 * Recompute the reputation record for `tenantId` and, if it changed, persist
 * it and enqueue a `TENANT_REPUTATION_UPDATE` outbox item.
 *
 * This is safe to call concurrently for different tenants; the store upsert
 * and outbox create are independent per-row operations.
 */
export async function syncTenantReputation(tenantId: string): Promise<void> {
  const [ratingRecords, paymentRows] = await Promise.all([
    tenantRatingStore.listRatingsForTenant(tenantId),
    fetchPaymentRows(tenantId),
  ])

  const record = computeReputationRecord(paymentRows, ratingRecords)

  const previous = await tenantReputationStore.findByTenantId(tenantId)

  if (
    previous !== null &&
    reputationRecordsEqual(record, {
      compositeScore:     previous.compositeScore,
      paymentScore:       previous.paymentScore,
      propertyCareScore:  previous.propertyCareScore,
      communicationScore: previous.communicationScore,
      totalRatings:       previous.totalRatings,
    })
  ) {
    logger.debug('Tenant reputation unchanged; skipping outbox enqueue', { tenantId })
    return
  }

  await tenantReputationStore.upsert(tenantId, record)

  // Scale 0–100 scores to 0–1000 for the on-chain contract (×10).
  // The outbox sender (sendTenantReputationUpdate) reads raw payload values
  // and passes them directly to adapter.updateTenantReputation which expects
  // the 0–1000 range documented in TenantReputationRecord.
  await outboxStore.create({
    txType:        TxType.TENANT_REPUTATION_UPDATE,
    source:        'tenant_reputation',
    ref:           tenantId,
    aggregateType: 'tenant',
    aggregateId:   tenantId,
    eventType:     'TENANT_REPUTATION_UPDATE',
    payload: {
      tenantId,
      compositeScore:     record.compositeScore    * 10,
      paymentScore:       record.paymentScore      * 10,
      propertyCareScore:  record.propertyCareScore * 10,
      communicationScore: record.communicationScore * 10,
      totalRatings:       record.totalRatings,
    },
  })

  logger.info('Tenant reputation synced', {
    tenantId,
    compositeScore:     record.compositeScore,
    paymentScore:       record.paymentScore,
    propertyCareScore:  record.propertyCareScore,
    communicationScore: record.communicationScore,
    totalRatings:       record.totalRatings,
  })
}
