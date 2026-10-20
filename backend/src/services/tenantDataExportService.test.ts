import { describe, it, expect, beforeEach, vi } from 'vitest'

const storage = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  generatePresignedDownload: vi.fn(),
}))
vi.mock('./storageService.js', () => storage)

import {
  InMemoryTenantDataExportStore,
  type TenantDataExportStore,
} from '../models/tenantDataExportStore.js'
import { userStore } from '../models/authStore.js'
import {
  buildExportFiles,
  defaultExportSources,
  expireTenantDataExports,
  exportStorageKey,
  generateTenantDataExport,
  EXPORT_ARCHIVE_TTL_MS,
  type ExportSources,
} from './tenantDataExportService.js'

function fakeSources(overrides: Partial<ExportSources> = {}): ExportSources {
  return {
    getProfile: async () => ({ id: 'tenant-1', email: 'tenant@example.com', name: 'Tenant' }),
    listApplications: async () => [{ applicationId: 'APP-1' }],
    listDeals: async () => [{ dealId: 'DEAL-1' }, { dealId: 'DEAL-2' }],
    listDocuments: async () => [],
    listNotifications: async () => [{ title: 'Welcome' }],
    getPreferences: () => ({ inApp: true }),
    ...overrides,
  }
}

function zipEntryNames(zip: Buffer): string[] {
  const names: string[] = []
  let offset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  while (offset !== -1 && offset + 46 <= zip.length) {
    const nameLength = zip.readUInt16LE(offset + 28)
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'))
    offset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset + 46 + nameLength)
  }
  return names
}

describe('tenant data export service (#1899)', () => {
  let store: TenantDataExportStore

  beforeEach(() => {
    vi.clearAllMocks()
    store = new InMemoryTenantDataExportStore()
    storage.uploadFile.mockResolvedValue({ key: 'k', url: 'u' })
    storage.deleteFile.mockResolvedValue(undefined)
  })

  describe('buildExportFiles', () => {
    it('writes one JSON file per domain plus a manifest that counts records', () => {
      const files = buildExportFiles(
        'tenant-1',
        {
          profile: { id: 'tenant-1' },
          applications: [{}],
          deals: [{}, {}],
          documents: [],
          notifications: [{}, {}, {}],
          preferences: { inApp: true },
        },
        new Date('2026-10-19T10:00:00.000Z'),
      )

      expect(Object.keys(files).sort()).toEqual([
        'applications.json',
        'deals.json',
        'documents.json',
        'manifest.json',
        'notifications.json',
        'preferences.json',
        'profile.json',
      ])
      const manifest = JSON.parse(files['manifest.json'].toString('utf8'))
      expect(manifest.userId).toBe('tenant-1')
      expect(manifest.files.find((f: { name: string }) => f.name === 'deals.json').recordCount).toBe(2)
      expect(manifest.files.find((f: { name: string }) => f.name === 'notifications.json').recordCount).toBe(3)
    })
  })

  describe('defaultExportSources.getProfile', () => {
    it('never includes credentials or key material', async () => {
      vi.spyOn(userStore, 'getById').mockResolvedValue({
        id: 'tenant-1',
        email: 'tenant@example.com',
        name: 'Tenant',
        role: 'tenant',
        tier: 'free',
        planQuota: 3,
        displayCurrency: 'NGN',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        // Fields that exist on richer records and must never be exported.
        passwordHash: 'hash',
        refreshToken: 'refresh',
        encryptedWalletKey: 'enc',
      } as any)

      const profile = await defaultExportSources.getProfile('tenant-1')

      expect(profile).not.toBeNull()
      const serialised = JSON.stringify(profile)
      expect(serialised).not.toContain('passwordHash')
      expect(serialised).not.toContain('refreshToken')
      expect(serialised).not.toContain('encryptedWalletKey')
      expect(serialised).not.toContain('hash')
    })
  })

  describe('generateTenantDataExport', () => {
    it('builds, uploads under the per-user prefix and marks the request ready', async () => {
      const record = await store.create('tenant-1')
      const now = new Date('2026-10-19T10:00:00.000Z')
      const upload = vi.fn().mockResolvedValue({ key: 'k', url: 'u' })

      const result = await generateTenantDataExport(record.id, {
        store,
        sources: fakeSources(),
        upload,
        now: () => now,
      })

      expect(result.status).toBe('ready')
      const [key, body, contentType] = upload.mock.calls[0]
      expect(key).toBe(exportStorageKey('tenant-1', record.id))
      expect(key.startsWith('tenant-data-exports/tenant-1/')).toBe(true)
      expect(contentType).toBe('application/zip')
      expect(body.readUInt32LE(0)).toBe(0x04034b50)

      const names = zipEntryNames(body)
      expect(names).toContain('manifest.json')
      expect(names).toContain('profile.json')

      const updated = await store.findById(record.id)
      expect(updated).toMatchObject({ status: 'ready', storageKey: key })
      expect(updated!.completedAt!.toISOString()).toBe(now.toISOString())
      expect(updated!.expiresAt!.getTime()).toBe(now.getTime() + EXPORT_ARCHIVE_TTL_MS)
    })

    it('skips a request that is no longer pending, so re-delivered jobs are harmless', async () => {
      const record = await store.create('tenant-1')
      await store.update(record.id, { status: 'ready' })
      const upload = vi.fn()

      const result = await generateTenantDataExport(record.id, { store, sources: fakeSources(), upload })

      expect(result.status).toBe('ready')
      expect(upload).not.toHaveBeenCalled()
    })

    it('records a generic failure reason and does not rethrow when upload fails', async () => {
      const record = await store.create('tenant-1')
      const upload = vi.fn().mockRejectedValue(new Error('s3 credentials invalid: AKIA...'))

      const result = await generateTenantDataExport(record.id, { store, sources: fakeSources(), upload })

      expect(result.status).toBe('failed')
      const updated = await store.findById(record.id)
      expect(updated!.status).toBe('failed')
      expect(updated!.failureReason).toBe(
        'The export could not be generated. Please request a new export.',
      )
      expect(updated!.failureReason).not.toContain('AKIA')
    })
  })

  describe('expireTenantDataExports', () => {
    it('deletes archives past their window and marks them expired, leaving live ones alone', async () => {
      const now = new Date('2026-10-30T00:00:00.000Z')
      const stale = await store.create('tenant-1')
      await store.update(stale.id, {
        status: 'ready',
        storageKey: 'tenant-data-exports/tenant-1/old.zip',
        expiresAt: new Date('2026-10-29T00:00:00.000Z'),
      })
      const live = await store.create('tenant-2')
      await store.update(live.id, {
        status: 'ready',
        storageKey: 'tenant-data-exports/tenant-2/new.zip',
        expiresAt: new Date('2026-11-05T00:00:00.000Z'),
      })

      const expired = await expireTenantDataExports(now, store)

      expect(expired).toBe(1)
      expect(storage.deleteFile).toHaveBeenCalledWith('tenant-data-exports/tenant-1/old.zip')
      expect(storage.deleteFile).not.toHaveBeenCalledWith('tenant-data-exports/tenant-2/new.zip')
      expect(await store.findById(stale.id)).toMatchObject({ status: 'expired', storageKey: null })
      expect(await store.findById(live.id)).toMatchObject({ status: 'ready' })
    })
  })
})
