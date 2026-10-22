/**
 * Backfill script — tenant reputation scores — issue #1980.
 *
 * Computes and (optionally) persists reputation records for every existing
 * tenant who has at least one rating or one repayment schedule row.
 *
 * Usage:
 *   # Dry run (default) — prints what would be synced, writes nothing
 *   tsx src/scripts/backfillTenantReputation.ts
 *
 *   # Live run — persists records and enqueues outbox items for changed tenants
 *   tsx src/scripts/backfillTenantReputation.ts --apply
 *
 *   # Limit to one tenant
 *   tsx src/scripts/backfillTenantReputation.ts --apply --tenantId=<id>
 *
 * The script exits with code 0 on success, non-zero on any unhandled error.
 * It is safe to re-run; the upsert is idempotent and the change-only enqueue
 * means tenants whose scores have not changed since the last sync produce no
 * duplicate outbox items.
 */

import { getPool, closeDbPools } from '../db.js'
import { initTenantRatingStore, PostgresTenantRatingStore } from '../models/tenantRatingStore.js'
import {
  initTenantReputationStore,
  PostgresTenantReputationStore,
} from '../models/tenantReputationStore.js'
import { initOutboxStore, PostgresOutboxStore } from '../outbox/store.js'
import { syncTenantReputation, computeReputationRecord } from '../services/tenantReputationService.js'
import { logger } from '../utils/logger.js'

// ── CLI argument parsing ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const apply   = args.includes('--apply')
const dryRun  = !apply
const tenantIdArg = args.find((a) => a.startsWith('--tenantId='))?.split('=')[1]

// ── Store initialisation ──────────────────────────────────────────────────

async function initStores(): Promise<void> {
  initTenantRatingStore(new PostgresTenantRatingStore())
  initTenantReputationStore(new PostgresTenantReputationStore())
  initOutboxStore(new PostgresOutboxStore())
}

// ── Tenant discovery ──────────────────────────────────────────────────────

/**
 * Returns the unique set of tenant IDs that have at least one rating or one
 * non-pending, non-waived repayment schedule row.
 */
async function discoverTenantIds(specificId?: string): Promise<string[]> {
  const pool = await getPool()
  if (!pool) throw new Error('DATABASE_URL is not set — backfill requires a live database')

  if (specificId) {
    return [specificId]
  }

  const { rows } = await pool.query<{ tenant_id: string }>(`
    SELECT DISTINCT tenant_id FROM tenant_ratings
    UNION
    SELECT DISTINCT td.tenant_id
    FROM repayment_schedule rs
    JOIN tenant_deals td ON td.deal_id = rs.deal_id
    WHERE rs.status IN ('paid', 'overdue')
    ORDER BY tenant_id
  `)

  return rows.map((r) => r.tenant_id)
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('Tenant reputation backfill starting', { dryRun, tenantIdArg })

  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is not set — backfill requires a live database')
    process.exit(1)
  }

  await initStores()

  const tenantIds = await discoverTenantIds(tenantIdArg)
  logger.info(`Discovered ${tenantIds.length} tenant(s) to process`)

  let synced    = 0
  let unchanged = 0
  let errors    = 0

  for (const tenantId of tenantIds) {
    try {
      if (dryRun) {
        // Dry run: compute the record and log what would happen, but write nothing.
        const { tenantRatingStore } = await import('../models/tenantRatingStore.js')
        const pool = await getPool()

        const ratings = await tenantRatingStore.listRatingsForTenant(tenantId)

        let paymentRows: Array<{ dueDate: string; paidAt: string | null; status: string }> = []
        if (pool) {
          const { rows } = await pool.query(
            `SELECT rs.due_date, rs.paid_at, rs.status
             FROM repayment_schedule rs
             JOIN tenant_deals td ON td.deal_id = rs.deal_id
             WHERE td.tenant_id = $1 AND rs.status IN ('paid', 'overdue')`,
            [tenantId],
          )
          paymentRows = rows
        }

        const record = computeReputationRecord(
          paymentRows.map((r) => ({
            dueDate: r.due_date,
            paidAt:  r.paid_at,
            status:  r.status as 'paid' | 'overdue',
          })),
          ratings,
        )

        logger.info('[DRY RUN] Would sync tenant', {
          tenantId,
          compositeScore:     record.compositeScore,
          paymentScore:       record.paymentScore,
          propertyCareScore:  record.propertyCareScore,
          communicationScore: record.communicationScore,
          totalRatings:       record.totalRatings,
        })
        synced++
      } else {
        // Live run: syncTenantReputation handles the change-only enqueue
        const { tenantReputationStore } = await import('../models/tenantReputationStore.js')
        const before = await tenantReputationStore.findByTenantId(tenantId)

        await syncTenantReputation(tenantId)

        const after = await tenantReputationStore.findByTenantId(tenantId)
        if (
          before !== null &&
          after !== null &&
          before.compositeScore     === after.compositeScore &&
          before.paymentScore       === after.paymentScore &&
          before.propertyCareScore  === after.propertyCareScore &&
          before.communicationScore === after.communicationScore &&
          before.totalRatings       === after.totalRatings
        ) {
          unchanged++
        } else {
          synced++
        }
      }
    } catch (err) {
      errors++
      logger.error('Failed to process tenant', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('Tenant reputation backfill complete', {
    dryRun,
    total: tenantIds.length,
    synced,
    unchanged,
    errors,
  })

  if (errors > 0) {
    process.exitCode = 1
  }
}

main()
  .catch((err) => {
    logger.error('Backfill script crashed', {
      error: err instanceof Error ? err.message : String(err),
    })
    process.exit(1)
  })
  .finally(async () => {
    await closeDbPools()
  })
