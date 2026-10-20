/**
 * Tenant personal-data export — issue #1899.
 *
 * Collects a tenant's own data from the existing stores into a ZIP archive
 * containing one JSON file per domain plus manifest.json, uploads it under a
 * per-user storage prefix and marks the request ready. Archives expire 7 days
 * after they become ready; expireTenantDataExports deletes them.
 *
 * Secrets are excluded by construction: each domain is built from an explicit
 * field list, never by spreading a full record. Password hashes, wallet keys
 * and refresh tokens are not reachable from any source below.
 */

import { getPool } from '../db.js'
import { userStore } from '../models/authStore.js'
import { dealStore } from '../models/dealStore.js'
import { tenantApplicationStore } from '../models/tenantApplicationStore.js'
import { getTenantDocumentVaultStore } from '../models/tenantDocumentVaultStore.js'
import { notificationPreferenceStore } from '../models/notificationPreferenceStore.js'
import {
  tenantDataExportStore,
  type TenantDataExport,
  type TenantDataExportStore,
} from '../models/tenantDataExportStore.js'
import { deleteFile, uploadFile } from './storageService.js'
import { createZipArchive } from '../utils/zipArchive.js'
import { logger } from '../utils/logger.js'

export const TENANT_DATA_EXPORT_JOB_NAME = 'tenant.data_export'
export const EXPORT_ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const EXPORT_RATE_LIMIT_MS = 24 * 60 * 60 * 1000
export const EXPORT_SCHEMA_VERSION = 1

const PAGE_SIZE = 100
const NOTIFICATION_LIMIT = 1000

export type ExportDomains = {
  profile: Record<string, unknown> | null
  applications: unknown[]
  deals: unknown[]
  documents: unknown[]
  notifications: unknown[]
  preferences: Record<string, unknown>
}

/** Where each domain is read from. Replaceable so tests can run without a database. */
export interface ExportSources {
  getProfile(userId: string): Promise<Record<string, unknown> | null>
  listApplications(userId: string): Promise<unknown[]>
  listDeals(userId: string): Promise<unknown[]>
  listDocuments(userId: string): Promise<unknown[]>
  listNotifications(userId: string): Promise<unknown[]>
  getPreferences(userId: string): Record<string, unknown>
}

async function collectAllPages<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; hasMore: boolean }>,
): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; ; page++) {
    const { items, hasMore } = await fetchPage(page)
    all.push(...items)
    if (!hasMore || items.length === 0) return all
  }
}

export const defaultExportSources: ExportSources = {
  async getProfile(userId) {
    const user = await userStore.getById(userId)
    if (!user) return null
    // Explicit field list: no password, token or key material.
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tier: user.tier,
      displayCurrency: user.displayCurrency,
      walletAddress: user.walletAddress ?? null,
      createdAt: user.createdAt.toISOString(),
    }
  },

  async listApplications(userId) {
    const items: unknown[] = []
    let cursor: string | undefined
    do {
      const result = await tenantApplicationStore.findByUserId(userId, { limit: PAGE_SIZE, cursor })
      items.push(...result.applications)
      cursor = result.nextCursor
    } while (cursor)
    return items
  },

  async listDeals(userId) {
    return collectAllPages(async (page) => {
      const result = await dealStore.findMany({ tenantId: userId, page, pageSize: PAGE_SIZE })
      return { items: result.deals, hasMore: page < result.totalPages }
    })
  },

  async listDocuments(userId) {
    const vault = getTenantDocumentVaultStore()
    return collectAllPages(async (page) => {
      const result = await vault.list(userId, { page, pageSize: PAGE_SIZE })
      return {
        items: result.documents,
        hasMore: page * PAGE_SIZE < result.total,
      }
    })
  },

  async listNotifications(userId) {
    const pool = await getPool()
    if (!pool) return []
    const result = await pool.query(
      `SELECT id, category, title, body, data, created_at
       FROM user_notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, NOTIFICATION_LIMIT],
    )
    return result.rows
  },

  getPreferences(userId) {
    return { ...notificationPreferenceStore.get(userId) } as Record<string, unknown>
  },
}

export async function collectExportDomains(
  userId: string,
  sources: ExportSources = defaultExportSources,
): Promise<ExportDomains> {
  const [profile, applications, deals, documents, notifications] = await Promise.all([
    sources.getProfile(userId),
    sources.listApplications(userId),
    sources.listDeals(userId),
    sources.listDocuments(userId),
    sources.listNotifications(userId),
  ])
  return {
    profile,
    applications,
    deals,
    documents,
    notifications,
    preferences: sources.getPreferences(userId),
  }
}

/**
 * Turn the collected domains into archive entries: one JSON file per domain and
 * a manifest listing them with their record counts.
 */
export function buildExportFiles(
  userId: string,
  domains: ExportDomains,
  generatedAt: Date,
): Record<string, Buffer> {
  const entries: Array<[string, unknown, number]> = [
    ['profile.json', domains.profile, domains.profile ? 1 : 0],
    ['applications.json', domains.applications, domains.applications.length],
    ['deals.json', domains.deals, domains.deals.length],
    ['documents.json', domains.documents, domains.documents.length],
    ['notifications.json', domains.notifications, domains.notifications.length],
    ['preferences.json', domains.preferences, 1],
  ]

  const files: Record<string, Buffer> = {}
  for (const [name, data] of entries) {
    files[name] = Buffer.from(JSON.stringify(data, null, 2), 'utf8')
  }

  const manifest = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    userId,
    generatedAt: generatedAt.toISOString(),
    files: entries.map(([name, , recordCount]) => ({ name, recordCount })),
  }
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  return files
}

export function exportStorageKey(userId: string, exportId: string): string {
  return `tenant-data-exports/${userId}/${exportId}.zip`
}

export interface ExportGenerationDeps {
  store?: TenantDataExportStore
  sources?: ExportSources
  upload?: (key: string, body: Buffer, contentType: string) => Promise<unknown>
  now?: () => Date
}

/**
 * Job handler body: builds and stores the archive for one export request.
 * Requests that are no longer pending are skipped, so a re-delivered job is
 * harmless. A failure is recorded on the request and not rethrown; the user
 * can request a new export.
 */
export async function generateTenantDataExport(
  exportId: string,
  deps: ExportGenerationDeps = {},
): Promise<{ status: string }> {
  const store = deps.store ?? tenantDataExportStore
  const sources = deps.sources ?? defaultExportSources
  const upload =
    deps.upload ??
    ((key: string, body: Buffer, contentType: string) => uploadFile(key, body, contentType))
  const now = deps.now ?? (() => new Date())

  const record = await store.findById(exportId)
  if (!record || record.status !== 'pending') {
    return { status: record?.status ?? 'missing' }
  }

  await store.update(exportId, { status: 'processing' })
  try {
    const generatedAt = now()
    const domains = await collectExportDomains(record.userId, sources)
    const archive = createZipArchive(buildExportFiles(record.userId, domains, generatedAt))
    const storageKey = exportStorageKey(record.userId, exportId)
    await upload(storageKey, archive, 'application/zip')

    await store.update(exportId, {
      status: 'ready',
      storageKey,
      completedAt: generatedAt,
      expiresAt: new Date(generatedAt.getTime() + EXPORT_ARCHIVE_TTL_MS),
    })
    return { status: 'ready' }
  } catch (error) {
    logger.error('tenant.data_export.failed', { exportId }, error)
    await store.update(exportId, {
      status: 'failed',
      failureReason: 'The export could not be generated. Please request a new export.',
    })
    return { status: 'failed' }
  }
}

/** Deletes archives whose 7-day window has passed and marks them expired. */
export async function expireTenantDataExports(
  now: Date = new Date(),
  store: TenantDataExportStore = tenantDataExportStore,
): Promise<number> {
  const due = await store.listExpiredReady(now)
  let expired = 0
  for (const record of due) {
    try {
      if (record.storageKey) await deleteFile(record.storageKey)
      await store.update(record.id, { status: 'expired', storageKey: null })
      expired += 1
    } catch (error) {
      logger.warn('tenant.data_export.expire_failed', { exportId: record.id, error: String(error) })
    }
  }
  return expired
}

/** The status a caller should see, taking expiry into account before the sweep runs. */
export function effectiveExportStatus(record: TenantDataExport, now: Date): TenantDataExport['status'] {
  if (record.status === 'ready' && record.expiresAt && record.expiresAt <= now) {
    return 'expired'
  }
  return record.status
}
