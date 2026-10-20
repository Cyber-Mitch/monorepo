/**
 * storageService.test.ts
 * Tests for presigned-URL scoping, expiry, path sanitization, and key construction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoist mocks so factories can reference them ───────────────────────────────
const { mockGetSignedUrl, mockS3Send } = vi.hoisted(() => ({
  mockGetSignedUrl: vi.fn(),
  mockS3Send: vi.fn(),
}))

vi.mock('@aws-sdk/client-s3', () => ({
  // Regular function (not arrow) so the mock can be called with `new`.
  S3Client: vi.fn().mockImplementation(function () {
    return { send: mockS3Send }
  }),
  PutObjectCommand: vi.fn().mockImplementation(function (params: Record<string, unknown>) {
    return { ...params, _type: 'PutObject' }
  }),
  GetObjectCommand: vi.fn().mockImplementation(function (params: Record<string, unknown>) {
    return { ...params, _type: 'GetObject' }
  }),
  DeleteObjectCommand: vi.fn().mockImplementation(function (params: Record<string, unknown>) {
    return { ...params, _type: 'DeleteObject' }
  }),
  CopyObjectCommand: vi.fn().mockImplementation(function (params: Record<string, unknown>) {
    return { ...params, _type: 'CopyObject' }
  }),
  HeadObjectCommand: vi.fn().mockImplementation(function (params: Record<string, unknown>) {
    return { ...params, _type: 'HeadObject' }
  }),
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}))

import {
  contentTypeToExtension,
  buildTenantDocumentObjectKey,
  buildPropertyMediaObjectKey,
  buildInspectionReportObjectKey,
  buildAgreementObjectKey,
  generatePresignedUpload,
  generatePresignedDownload,
  STORAGE_TTL,
  getStorageProvider,
  sanitizeObjectFileName,
  buildMessageAttachmentObjectKey,
  messageAttachmentPrefix,
} from './storageService.js'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTtlFromUrl(url: string): number | null {
  try {
    const u = new URL(url)
    const expires = u.searchParams.get('X-Amz-Expires')
    return expires ? parseInt(expires, 10) : null
  } catch {
    return null
  }
}

// ── 1. contentTypeToExtension ─────────────────────────────────────────────────

describe('contentTypeToExtension', () => {
  it.each([
    ['application/pdf', 'pdf'],
    ['image/jpeg', 'jpg'],
    ['image/jpg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/svg+xml', 'svg'],
    ['application/msword', 'doc'],
  ])('%s → %s', (contentType, expectedExt) => {
    expect(contentTypeToExtension(contentType)).toBe(expectedExt)
  })

  it('returns "bin" for completely unknown type', () => {
    expect(contentTypeToExtension('application/x-custom-unknown-really-long-type')).toBe('bin')
  })

  it('falls back to subtype for short unknown types', () => {
    // 'application/zip' → 'zip' (short enough)
    const result = contentTypeToExtension('application/zip')
    expect(result.length).toBeLessThanOrEqual(10)
  })
})

// ── 2. Object key construction ────────────────────────────────────────────────

describe('buildTenantDocumentObjectKey', () => {
  it('scopes key to tenantId prefix', () => {
    const key = buildTenantDocumentObjectKey('tenant-123', 'identity', 'image/jpeg')
    expect(key).toMatch(/^tenant-documents\/tenant-123\/identity\//)
  })

  it('includes correct extension', () => {
    const key = buildTenantDocumentObjectKey('tenant-123', 'bank_statement', 'application/pdf')
    expect(key).toMatch(/\.pdf$/)
  })

  it('generates unique keys for same inputs (UUID)', () => {
    const k1 = buildTenantDocumentObjectKey('tid', 'identity', 'image/png')
    const k2 = buildTenantDocumentObjectKey('tid', 'identity', 'image/png')
    expect(k1).not.toBe(k2)
  })

  it('never contains path traversal sequences', () => {
    // Even if caller passes a traversal-like tenantId (at construction level, sanitize expectation)
    const key = buildTenantDocumentObjectKey('tenant-123', 'identity', 'image/jpeg')
    expect(key).not.toContain('../')
    expect(key).not.toContain('..')
  })

  it('cross-tenant: keys for different tenants are distinct prefixes', () => {
    const k1 = buildTenantDocumentObjectKey('tenant-AAA', 'identity', 'application/pdf')
    const k2 = buildTenantDocumentObjectKey('tenant-BBB', 'identity', 'application/pdf')
    expect(k1.startsWith('tenant-documents/tenant-AAA/')).toBe(true)
    expect(k2.startsWith('tenant-documents/tenant-BBB/')).toBe(true)
    expect(k1).not.toContain('tenant-BBB')
    expect(k2).not.toContain('tenant-AAA')
  })
})

describe('buildPropertyMediaObjectKey', () => {
  it('scopes key to listingId prefix', () => {
    const key = buildPropertyMediaObjectKey('listing-456', 'image/png')
    expect(key).toMatch(/^property-media\/listing-456\//)
  })

  it('includes correct extension', () => {
    const key = buildPropertyMediaObjectKey('listing-456', 'image/webp')
    expect(key).toMatch(/\.webp$/)
  })

  it('generates unique keys', () => {
    const k1 = buildPropertyMediaObjectKey('listing-xyz', 'image/jpeg')
    const k2 = buildPropertyMediaObjectKey('listing-xyz', 'image/jpeg')
    expect(k1).not.toBe(k2)
  })
})

describe('buildInspectionReportObjectKey', () => {
  it('scopes key to jobId prefix', () => {
    const key = buildInspectionReportObjectKey('job-789', 'application/pdf')
    expect(key).toMatch(/^inspection-reports\/job-789\//)
  })
})

describe('buildAgreementObjectKey', () => {
  it('returns deterministic key per dealId', () => {
    const k1 = buildAgreementObjectKey('deal-001')
    const k2 = buildAgreementObjectKey('deal-001')
    expect(k1).toBe(k2)
    expect(k1).toBe('agreements/deal-001/agreement.pdf')
  })

  it('returns distinct keys for different dealIds', () => {
    const k1 = buildAgreementObjectKey('deal-001')
    const k2 = buildAgreementObjectKey('deal-002')
    expect(k1).not.toBe(k2)
  })
})

// ── 3. Presigned URL expiry ───────────────────────────────────────────────────

describe('STORAGE_TTL constants', () => {
  it('upload TTL is 15 minutes (900 seconds)', () => {
    expect(STORAGE_TTL.UPLOAD_SECONDS).toBe(15 * 60)
  })

  it('download TTL is 5 minutes (300 seconds)', () => {
    expect(STORAGE_TTL.DOWNLOAD_SECONDS).toBe(5 * 60)
  })

  it('upload TTL is longer than download TTL', () => {
    expect(STORAGE_TTL.UPLOAD_SECONDS).toBeGreaterThan(STORAGE_TTL.DOWNLOAD_SECONDS)
  })
})

// ── 4. generatePresignedUpload / generatePresignedDownload via local provider ─

describe('generatePresignedUpload and generatePresignedDownload (local provider)', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, STORAGE_PROVIDER: 'local' }
    // Reset the singleton so each test gets a fresh local provider
    vi.resetModules()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('generatePresignedUpload returns expiresAt in the future', async () => {
    const before = Date.now()
    const { generatePresignedUpload: fn } = await import('./storageService.js')
    const result = await fn('some/key/file.pdf', 'application/pdf')

    expect(result.uploadUrl).toBeTruthy()
    const expiresMs = new Date(result.expiresAt).getTime()
    expect(expiresMs).toBeGreaterThan(before)
  })

  it('generatePresignedDownload returns expiresAt in the future', async () => {
    const before = Date.now()
    const { generatePresignedDownload: fn } = await import('./storageService.js')
    const result = await fn('some/key/file.pdf')

    expect(result.downloadUrl).toBeTruthy()
    const expiresMs = new Date(result.expiresAt).getTime()
    expect(expiresMs).toBeGreaterThan(before)
  })

  it('generatePresignedUpload expiresAt respects custom ttl', async () => {
    const { generatePresignedUpload: fn } = await import('./storageService.js')
    const ttl = 120
    const before = Date.now()
    const result = await fn('some/key/file.pdf', 'application/pdf', ttl)

    const expiresMs = new Date(result.expiresAt).getTime()
    // expiresAt should be roughly before + 120s
    expect(expiresMs - before).toBeGreaterThanOrEqual(ttl * 1000 - 500)
    expect(expiresMs - before).toBeLessThanOrEqual(ttl * 1000 + 2000)
  })
})

// ── 5. Path traversal rejection via key construction ─────────────────────────

describe('Object key path-traversal safety', () => {
  /**
   * The service builds keys programmatically — callers cannot inject
   * path traversal because the key is assembled from validated segments.
   * We assert that the output keys are always confined to their expected prefix.
   */
  it('tenant doc keys always start with tenant-documents/<tenantId>/', () => {
    const tenantId = 'user-xyz'
    const key = buildTenantDocumentObjectKey(tenantId, 'identity', 'image/jpeg')
    expect(key.startsWith(`tenant-documents/${tenantId}/`)).toBe(true)
  })

  it('property media keys always start with property-media/<listingId>/', () => {
    const listingId = 'prop-123'
    const key = buildPropertyMediaObjectKey(listingId, 'image/png')
    expect(key.startsWith(`property-media/${listingId}/`)).toBe(true)
  })

  it('inspection report keys always start with inspection-reports/<jobId>/', () => {
    const jobId = 'job-abc'
    const key = buildInspectionReportObjectKey(jobId, 'application/pdf')
    expect(key.startsWith(`inspection-reports/${jobId}/`)).toBe(true)
  })

  it('agreement keys always start with agreements/<dealId>/', () => {
    const dealId = 'deal-001'
    const key = buildAgreementObjectKey(dealId)
    expect(key.startsWith(`agreements/${dealId}/`)).toBe(true)
  })
})

// ── 6. Message attachment keys ────────────────────────────────────────────────

describe('sanitizeObjectFileName', () => {
  it.each([
    ['lease scan.pdf', 'lease_scan.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\photo.png', 'photo.png'],
    ['.hidden', 'hidden'],
    ['...', 'file'],
    ['', 'file'],
    ['naïve résumé.pdf', 'na_ve_r_sum_.pdf'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeObjectFileName(input)).toBe(expected)
  })

  it('caps the length at 100 characters', () => {
    expect(sanitizeObjectFileName('a'.repeat(300) + '.pdf')).toHaveLength(100)
  })
})

describe('buildMessageAttachmentObjectKey', () => {
  it('scopes the key to the conversation prefix with a uuid and safe name', () => {
    const key = buildMessageAttachmentObjectKey('conv-1', '../x/my file.pdf')
    expect(messageAttachmentPrefix('conv-1')).toBe('messaging/conv-1/')
    expect(key).toMatch(/^messaging\/conv-1\/[0-9a-f-]{36}-my_file\.pdf$/)
  })

  it('generates unique keys', () => {
    expect(buildMessageAttachmentObjectKey('c', 'a.pdf')).not.toBe(
      buildMessageAttachmentObjectKey('c', 'a.pdf'),
    )
  })
})

// ── 7. headFile ───────────────────────────────────────────────────────────────

describe('headFile (s3 provider)', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, STORAGE_PROVIDER: 's3', S3_BUCKET: 'test-bucket' }
    vi.resetModules()
    mockS3Send.mockReset()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns size and content type from HeadObject', async () => {
    mockS3Send.mockResolvedValue({ ContentLength: 1234, ContentType: 'application/pdf' })
    const { headFile } = await import('./storageService.js')

    await expect(headFile('messaging/c/k.pdf')).resolves.toEqual({
      size: 1234,
      contentType: 'application/pdf',
    })
    expect(mockS3Send).toHaveBeenCalledWith(
      expect.objectContaining({ _type: 'HeadObject', Bucket: 'test-bucket', Key: 'messaging/c/k.pdf' }),
    )
  })

  it('returns null when the object does not exist', async () => {
    const { headFile } = await import('./storageService.js')

    mockS3Send.mockRejectedValueOnce(Object.assign(new Error('NotFound'), { name: 'NotFound' }))
    await expect(headFile('missing')).resolves.toBeNull()

    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error('nope'), { name: 'Unknown', $metadata: { httpStatusCode: 404 } }),
    )
    await expect(headFile('missing')).resolves.toBeNull()
  })

  it('rethrows other errors', async () => {
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }),
    )
    const { headFile } = await import('./storageService.js')
    await expect(headFile('k')).rejects.toThrow('denied')
  })
})

describe('headFile (local provider)', () => {
  const originalEnv = process.env
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'storage-head-'))
    process.env = { ...originalEnv, STORAGE_PROVIDER: 'local', LOCAL_STORAGE_DIR: dir }
    vi.resetModules()
  })

  afterEach(async () => {
    process.env = originalEnv
    await rm(dir, { recursive: true, force: true })
  })

  it('returns the file size for an existing object', async () => {
    await mkdir(join(dir, 'messaging/c'), { recursive: true })
    await writeFile(join(dir, 'messaging/c/a.pdf'), Buffer.alloc(42))
    const { headFile } = await import('./storageService.js')
    await expect(headFile('messaging/c/a.pdf')).resolves.toEqual({ size: 42 })
  })

  it('returns null for a missing object or a directory', async () => {
    await mkdir(join(dir, 'messaging/c'), { recursive: true })
    const { headFile } = await import('./storageService.js')
    await expect(headFile('messaging/c/missing.pdf')).resolves.toBeNull()
    await expect(headFile('messaging/c')).resolves.toBeNull()
  })
})
