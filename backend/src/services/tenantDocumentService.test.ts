/**
 * tenantDocumentService.test.ts
 * Tests for the tenant document vault: owner-only access, presigned access,
 * deletion, storage-quota, file-type validation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoist mocks before vi.mock factories ─────────────────────────────────

const {
  mockUploadFile,
  mockDeleteFile,
  mockGeneratePresignedDownload,
  mockRepoCreate,
  mockRepoDelete,
  mockRepoGetStorageKey,
  mockRepoGetTotalStorageBytes,
  mockFileTypeFromBuffer,
} = vi.hoisted(() => ({
  mockUploadFile: vi.fn(),
  mockDeleteFile: vi.fn(),
  mockGeneratePresignedDownload: vi.fn(),
  mockRepoCreate: vi.fn(),
  mockRepoDelete: vi.fn(),
  mockRepoGetStorageKey: vi.fn(),
  mockRepoGetTotalStorageBytes: vi.fn(),
  mockFileTypeFromBuffer: vi.fn(),
}))

vi.mock('./storageService.js', () => ({
  uploadFile: mockUploadFile,
  deleteFile: mockDeleteFile,
  generatePresignedDownload: mockGeneratePresignedDownload,
  generatePresignedUpload: vi.fn(),
  buildTenantDocumentObjectKey: vi.fn(),
}))

// The vault store replaced TenantDocumentRepository; findById is driven by the
// same storage-key mock (null ⇒ not found / not owned).
vi.mock('../models/tenantDocumentVaultStore.js', () => ({
  getTenantDocumentVaultStore: () => ({
    create: mockRepoCreate,
    delete: mockRepoDelete,
    getTotalStorageBytes: mockRepoGetTotalStorageBytes,
    findById: async (id: string, userId: string) => {
      const storageKey = await mockRepoGetStorageKey(id, userId)
      return storageKey ? { id, userId, storageKey, readOnly: false } : null
    },
  }),
}))

// file-type must be mocked to control MIME detection
vi.mock('file-type', () => ({
  fileTypeFromBuffer: mockFileTypeFromBuffer,
}))

import { TenantDocumentService } from './tenantDocumentService.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const MB = 1024 * 1024

function pdfBuffer(sizeBytes = 512 * 1024): Buffer {
  const buf = Buffer.alloc(sizeBytes)
  buf.write('%PDF-1.4', 0, 'ascii') // PDF magic
  return buf
}

function makeDocResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    userId: 'user-1',
    fileName: 'passport.pdf',
    fileFormat: 'pdf',
    fileSizeBytes: 512 * 1024,
    category: 'identity' as const,
    description: null,
    dealId: null,
    isLandlordUploaded: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('TenantDocumentService', () => {
  let service: TenantDocumentService

  beforeEach(() => {
    service = new TenantDocumentService()

    mockUploadFile.mockReset()
    mockDeleteFile.mockReset()
    mockGeneratePresignedDownload.mockReset()
    mockRepoCreate.mockReset()
    mockRepoDelete.mockReset()
    mockRepoGetStorageKey.mockReset()
    mockRepoGetTotalStorageBytes.mockReset()
    mockFileTypeFromBuffer.mockReset()

    // Default happy-path state
    mockFileTypeFromBuffer.mockResolvedValue({ mime: 'application/pdf', ext: 'pdf' })
    mockRepoGetTotalStorageBytes.mockResolvedValue(0)
    // Documents exist and belong to the caller unless a test says otherwise.
    mockRepoGetStorageKey.mockResolvedValue('tenant-documents/user-1/identity/uuid.pdf')
    mockUploadFile.mockResolvedValue({ key: 'tenant-documents/user-1/identity/uuid.pdf', url: 'https://s3.example.com/...' })
    mockRepoCreate.mockResolvedValue(makeDocResponse())
    mockGeneratePresignedDownload.mockResolvedValue({
      downloadUrl: 'https://presigned.example.com/doc?X-Amz-Expires=900',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── uploadDocument ──────────────────────────────────────────────────────────

  describe('uploadDocument', () => {
    it('uploads a valid PDF and returns a document response', async () => {
      const result = await service.uploadDocument(
        'user-1',
        pdfBuffer(),
        'passport.pdf',
        'identity',
      )

      expect(mockUploadFile).toHaveBeenCalledOnce()
      expect(mockRepoCreate).toHaveBeenCalledOnce()
      expect(result.userId).toBe('user-1')
    })

    it('accepts JPEG content type', async () => {
      mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' })
      const result = await service.uploadDocument('user-1', pdfBuffer(), 'id-card.jpg', 'identity')
      expect(result).toBeDefined()
    })

    it('accepts PNG content type', async () => {
      mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' })
      const result = await service.uploadDocument('user-1', pdfBuffer(), 'selfie.png', 'identity')
      expect(result).toBeDefined()
    })

    it('rejects SVG (disallowed type)', async () => {
      mockFileTypeFromBuffer.mockResolvedValue({ mime: 'image/svg+xml', ext: 'svg' })

      await expect(
        service.uploadDocument('user-1', pdfBuffer(), 'bad.svg', 'identity'),
      ).rejects.toThrow(/invalid file type/i)

      expect(mockUploadFile).not.toHaveBeenCalled()
      expect(mockRepoCreate).not.toHaveBeenCalled()
    })

    it('rejects mismatched magic bytes (extension vs content)', async () => {
      // file-type detects the real type from magic bytes, not filename
      mockFileTypeFromBuffer.mockResolvedValue({ mime: 'application/zip', ext: 'zip' })

      await expect(
        service.uploadDocument('user-1', Buffer.from('PK\x03\x04'), 'innocent.pdf', 'identity'),
      ).rejects.toThrow(/invalid file type/i)
    })

    it('rejects undetectable file type (null result)', async () => {
      mockFileTypeFromBuffer.mockResolvedValue(null)

      await expect(
        service.uploadDocument('user-1', Buffer.from('garbage'), 'file.pdf', 'identity'),
      ).rejects.toThrow(/invalid file type/i)
    })

    it('rejects file larger than 20 MB', async () => {
      const huge = Buffer.alloc(21 * MB)

      await expect(
        service.uploadDocument('user-1', huge, 'big.pdf', 'identity'),
      ).rejects.toThrow(/20 mb/i)

      expect(mockUploadFile).not.toHaveBeenCalled()
    })

    it('accepts file exactly at 20 MB limit', async () => {
      const exact = pdfBuffer(20 * MB)
      await expect(
        service.uploadDocument('user-1', exact, 'exact.pdf', 'identity'),
      ).resolves.toBeDefined()
    })

    it('rejects upload when storage quota exceeded', async () => {
      // Simulate user already at 490 MB + new 15 MB > 500 MB
      mockRepoGetTotalStorageBytes.mockResolvedValue(490 * MB)
      const file = pdfBuffer(15 * MB)

      await expect(
        service.uploadDocument('user-1', file, 'overdraft.pdf', 'identity'),
      ).rejects.toThrow(/quota/i)

      expect(mockUploadFile).not.toHaveBeenCalled()
    })

    it('scopes the storage key to userId', async () => {
      await service.uploadDocument('user-TENANT', pdfBuffer(), 'doc.pdf', 'identity')

      const uploadCallArgs = mockUploadFile.mock.calls[0]
      const objectKey: string = uploadCallArgs![0]
      expect(objectKey).toContain('tenant-documents/user-TENANT/')
    })

    it('keys for different tenants are disjoint (cross-tenant isolation)', async () => {
      const keys: string[] = []
      mockUploadFile.mockImplementation(async (key: string) => {
        keys.push(key)
        return { key, url: 'https://s3.example.com/...' }
      })

      await service.uploadDocument('user-AAA', pdfBuffer(), 'doc.pdf', 'identity')
      await service.uploadDocument('user-BBB', pdfBuffer(), 'doc.pdf', 'identity')

      expect(keys[0]).toContain('user-AAA')
      expect(keys[1]).toContain('user-BBB')
      expect(keys[0]).not.toContain('user-BBB')
      expect(keys[1]).not.toContain('user-AAA')
    })
  })

  // ── deleteDocument ──────────────────────────────────────────────────────────

  describe('deleteDocument', () => {
    it('deletes a document owned by the requesting user', async () => {
      mockRepoDelete.mockResolvedValue({ deleted: true, storageKey: 'tenant-documents/user-1/identity/uuid.pdf' })

      await expect(service.deleteDocument('doc-1', 'user-1')).resolves.toBeUndefined()
      expect(mockDeleteFile).toHaveBeenCalledWith('tenant-documents/user-1/identity/uuid.pdf')
    })

    it('throws NOT_FOUND when document does not belong to the user (owner-only enforcement)', async () => {
      // The repository enforces ownership by userId; returns deleted: false for mismatches
      mockRepoDelete.mockResolvedValue({ deleted: false })

      await expect(service.deleteDocument('doc-1', 'attacker')).rejects.toThrow(/not found/i)
      expect(mockDeleteFile).not.toHaveBeenCalled()
    })

    it('throws NOT_FOUND for a document that does not exist', async () => {
      mockRepoDelete.mockResolvedValue({ deleted: false })

      await expect(service.deleteDocument('ghost-doc', 'user-1')).rejects.toThrow(/not found/i)
    })

    it('proceeds even if S3 deletion fails (soft error)', async () => {
      mockRepoDelete.mockResolvedValue({ deleted: true, storageKey: 'key/file.pdf' })
      mockDeleteFile.mockRejectedValue(new Error('S3 timeout'))

      // Should NOT throw; S3 errors on delete are logged, not propagated
      await expect(service.deleteDocument('doc-1', 'user-1')).resolves.toBeUndefined()
    })

    it('does not attempt S3 deletion when storageKey is missing', async () => {
      mockRepoDelete.mockResolvedValue({ deleted: true, storageKey: null })

      await expect(service.deleteDocument('doc-1', 'user-1')).resolves.toBeUndefined()
      expect(mockDeleteFile).not.toHaveBeenCalled()
    })
  })

  // ── getDownloadUrl ──────────────────────────────────────────────────────────

  describe('getDownloadUrl', () => {
    it('returns a presigned short-lived URL for the owner', async () => {
      mockRepoGetStorageKey.mockResolvedValue('tenant-documents/user-1/identity/uuid.pdf')

      const url = await service.getDownloadUrl('doc-1', 'user-1')

      expect(url).toBe('https://presigned.example.com/doc?X-Amz-Expires=900')
      expect(mockGeneratePresignedDownload).toHaveBeenCalledWith(
        'tenant-documents/user-1/identity/uuid.pdf',
        expect.any(Number),
      )
    })

    it('uses the short TTL (15 minutes = 900 seconds)', async () => {
      mockRepoGetStorageKey.mockResolvedValue('some/key.pdf')
      await service.getDownloadUrl('doc-1', 'user-1')

      const ttl: number = mockGeneratePresignedDownload.mock.calls[0]![1]
      expect(ttl).toBe(15 * 60) // 900 seconds
    })

    it('throws NOT_FOUND for a document not owned by the user', async () => {
      // repo returns null when userId does not match
      mockRepoGetStorageKey.mockResolvedValue(null)

      await expect(service.getDownloadUrl('doc-1', 'attacker')).rejects.toThrow(/not found/i)
      expect(mockGeneratePresignedDownload).not.toHaveBeenCalled()
    })

    it('does not return a durable public URL (must go through presign)', async () => {
      mockRepoGetStorageKey.mockResolvedValue('tenant-documents/user-1/identity/uuid.pdf')

      const url = await service.getDownloadUrl('doc-1', 'user-1')

      // The returned URL should be what presign returned, not a raw S3 path
      expect(mockGeneratePresignedDownload).toHaveBeenCalledOnce()
      expect(url).toBe('https://presigned.example.com/doc?X-Amz-Expires=900')
    })
  })

  // ── addLandlordLeaseToVault ─────────────────────────────────────────────────

  describe('addLandlordLeaseToVault', () => {
    it('creates a read-only lease document for the tenant', async () => {
      const landlordDoc = makeDocResponse({ isLandlordUploaded: true })
      mockRepoCreate.mockResolvedValue(landlordDoc)

      const result = await service.addLandlordLeaseToVault(
        'tenant-1',
        'deal-1',
        'agreements/deal-1/agreement.pdf',
        'lease_2024.pdf',
        204800,
      )

      expect(mockRepoCreate).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({
          category: 'lease_agreement',
          isLandlordUploaded: true,
          readOnly: true,
          dealId: 'deal-1',
        }),
      )
      expect(result).toMatchObject({ isLandlordUploaded: true })
    })
  })
})
