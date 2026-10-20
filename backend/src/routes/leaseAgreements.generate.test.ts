import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const storageDir = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-route-'))
  process.env.STORAGE_PROVIDER = 'local'
  process.env.LOCAL_STORAGE_DIR = dir
  return dir
})

import { rmSync } from 'node:fs'
import request from 'supertest'
import express from 'express'
import { createLeaseAgreementsRouter } from './leaseAgreements.js'
import { dealStore } from '../models/dealStore.js'
import { listingStore } from '../models/listingStore.js'
import { leaseAgreementStore } from '../models/leaseAgreementStore.js'
import { leaseSignatureStore } from '../models/leaseSignatureStore.js'
import { userStore } from '../models/authStore.js'
import { computeLeaseDocumentHash } from '../services/leaseDocumentService.js'
import { getStorageProvider } from '../services/storageService.js'
import { extractPdfText } from '../test-fixtures/pdfText.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = {
      id: req.headers['x-test-user'] ?? 'admin-1',
      role: req.headers['x-test-role'] ?? 'admin',
    }
    next()
  },
}))

// No database in tests: names come from these stubs instead of the user store / onboarding table.
const names = vi.hoisted(() => ({ tenant: 'Ada Obi' as string | undefined, landlord: 'Chidi Eze' as string | undefined }))
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, getPool: async () => null }
})

afterAll(() => rmSync(storageDir, { recursive: true, force: true }))

describe('POST /deals/:dealId/lease/generate (#1954)', () => {
  let app: express.Application
  let dealId: string

  beforeEach(async () => {
    await dealStore.clear()
    await leaseAgreementStore.clear()
    await leaseSignatureStore.clear()
    names.tenant = 'Ada Obi'
    names.landlord = 'Chidi Eze'

    const listing = await listingStore.create({
      whistleblowerId: 'wb-1',
      address: '12 Admiralty Way, Lekki, Lagos',
      bedrooms: 2,
      bathrooms: 2,
      annualRentNgn: 1_200_000,
      photos: [],
    })
    const deal = await dealStore.create({
      tenantId: 'tenant-1',
      landlordId: 'landlord-1',
      listingId: listing.listingId,
      annualRentNgn: 1_200_000,
      depositNgn: 240_000,
      termMonths: 12,
    })
    dealId = deal.dealId

    vi.spyOn(userStore, 'getById').mockImplementation(async (id: string) =>
      id === 'tenant-1'
        ? ({ id, name: names.tenant ?? 'tenant', email: 'tenant@example.com' } as never)
        : ({ id, name: names.landlord ?? 'landlord', email: 'landlord@example.com' } as never),
    )
    vi.spyOn(userStore, 'getLandlordProfile').mockResolvedValue(null)

    app = express()
    app.use(express.json())
    app.use(requestIdMiddleware)
    app.use('/api', createLeaseAgreementsRouter())
    app.use(errorHandler)
  })

  it('stores a real PDF and a byte-level hash', async () => {
    const res = await request(app).post(`/api/deals/${dealId}/lease/generate`)

    expect(res.status).toBe(201)
    const { documentKey, documentHash, templateVersion } = res.body.data
    const { buffer } = await getStorageProvider().downloadFile(documentKey)

    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-')
    expect(documentHash).toBe(computeLeaseDocumentHash(buffer))
    expect(templateVersion).toBe('lease-v1')

    const lease = await leaseAgreementStore.getByDealId(dealId)
    expect(lease?.documentHash).toBe(documentHash)
    expect(lease?.templateVersion).toBe('lease-v1')
  })

  it('fills in the parties, address and terms, with no placeholders', async () => {
    const res = await request(app).post(`/api/deals/${dealId}/lease/generate`)
    const { buffer } = await getStorageProvider().downloadFile(res.body.data.documentKey)
    const text = extractPdfText(buffer).replace(/\s+/g, ' ')

    expect(text).toContain('Tenant: Ada Obi')
    expect(text).toContain('Landlord: Chidi Eze')
    expect(text).toContain('Address: 12 Admiralty Way, Lekki, Lagos')
    expect(text).toContain('Annual rent: NGN 1,200,000.00')
    expect(text).toContain('Deposit: NGN 240,000.00')
    expect(text).not.toMatch(/Tenant tenant-1|Landlord landlord-1/)
  })

  it('fails with 422 when a party has no legal name, and stores nothing', async () => {
    names.tenant = undefined // user record only has the email-derived "tenant"

    const res = await request(app).post(`/api/deals/${dealId}/lease/generate`)

    expect(res.status).toBe(422)
    expect(res.body.error.message).toMatch(/no legal name on record for tenant tenant-1/)
    expect(await leaseAgreementStore.getByDealId(dealId)).toBeNull()
  })

  it('fails with 422 when the deal has no listing address', async () => {
    const orphan = await dealStore.create({
      tenantId: 'tenant-1',
      landlordId: 'landlord-1',
      annualRentNgn: 1_200_000,
      depositNgn: 240_000,
      termMonths: 12,
    })

    const res = await request(app).post(`/api/deals/${orphan.dealId}/lease/generate`)

    expect(res.status).toBe(422)
    expect(res.body.error.message).toMatch(/no listing/)
  })

  it('still rejects non-admin, non-landlord callers', async () => {
    const res = await request(app)
      .post(`/api/deals/${dealId}/lease/generate`)
      .set('x-test-role', 'tenant')

    expect(res.status).toBe(403)
  })
})
