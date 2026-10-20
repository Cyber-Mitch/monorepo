import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { v4 as randomUUID } from 'uuid'

vi.mock('../services/storageService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/storageService.js')>()
  return {
    ...actual,
    generatePresignedUpload: vi.fn(async (key: string) => ({
      uploadUrl: `https://storage.test/upload/${key}`,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    })),
  }
})

import express from 'express'
import { createApp } from '../app.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'
import { createListingsRouter } from './listings.js'
import {
  createListingInspectionRouter,
  createPropertyInspectionsRouter,
} from './propertyInspections.js'
import {
  createAdminInspectionsRouter,
  createAdminInspectorsRouter,
} from './adminInspections.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { ListingStatus } from '../models/listing.js'
import { listingStore } from '../models/listingStore.js'
import {
  InMemoryPropertyInspectionStore,
  propertyInspectionStore,
} from '../models/propertyInspectionStore.js'
import {
  InMemoryInspectorProfileStore,
  inspectorProfileStore,
} from '../models/inspectorProfileStore.js'
import { INSPECTION_CATEGORIES } from '../services/inspectionTrustScore.js'

type Role = 'tenant' | 'admin' | 'inspector'

const FULL_CHECKLIST = INSPECTION_CATEGORIES.map((category) => ({
  category,
  item: `${category} check`,
  result: 'pass' as const,
  notes: 'Private inspector note',
}))

/**
 * Mirrors the app.ts mounts (both /api/v1 and the test-only /api prefix)
 * without the global rate limiters, which these multi-request flows would trip.
 * The 'app.ts mounting' block below checks the real createApp() wiring.
 */
function buildApp(): express.Express {
  const app = express()
  app.use(requestIdMiddleware)
  app.use(express.json())
  for (const prefix of ['/api/v1', '/api']) {
    app.use(`${prefix}/inspections`, createPropertyInspectionsRouter())
    app.use(`${prefix}/listings`, createListingInspectionRouter())
    app.use(`${prefix}/admin/inspections`, createAdminInspectionsRouter())
    app.use(`${prefix}/admin/inspectors`, createAdminInspectorsRouter())
  }
  app.use('/api/listings', createListingsRouter())
  app.use(errorHandler)
  return app
}

describe('Property inspections (#1904)', () => {
  const app = buildApp()
  let seq = 0

  let inspectorToken: string
  let inspectorId: string
  let inspectorEmail: string
  let otherInspectorToken: string
  let adminToken: string
  let adminId: string
  let tenantToken: string

  async function makeUser(role: Role): Promise<{ id: string; email: string; token: string }> {
    seq += 1
    const email = `inspections-${role}-${seq}@example.com`
    const user = await userStore.getOrCreateByEmail(email)
    user.role = role
    const token = `test-token-inspections-${role}-${seq}`
    await sessionStore.create(email, token)
    return { id: user.id, email, token }
  }

  async function createListing(approved = true) {
    const listing = await listingStore.create({
      whistleblowerId: `wb-${randomUUID()}`,
      address: '12 Admiralty Way',
      city: 'Lagos',
      area: 'Lekki',
      bedrooms: 2,
      bathrooms: 2,
      annualRentNgn: 2_500_000,
      description: 'Inspection test listing',
      photos: [],
    })
    if (approved) {
      await listingStore.moderate(listing.listingId, ListingStatus.APPROVED, 'test-admin')
    }
    return listing
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

  async function createInspection(listingId: string, token = inspectorToken, prefix = '/api/v1') {
    const res = await request(app)
      .post(`${prefix}/inspections`)
      .set(auth(token))
      .send({ listingId, scheduledAt: '2026-11-01T10:00:00.000Z' })
    expect(res.status).toBe(201)
    return res.body.data as { id: string; status: string; inspectorId: string }
  }

  async function startInspection(id: string) {
    await request(app).patch(`/api/v1/inspections/${id}/start`).set(auth(inspectorToken)).expect(200)
  }

  async function addPhotos(id: string, count: number) {
    for (let i = 0; i < count; i++) {
      const presign = await request(app)
        .post(`/api/v1/inspections/${id}/photos/presign`)
        .set(auth(inspectorToken))
        .send({ contentType: 'image/jpeg' })
        .expect(200)
      await request(app)
        .post(`/api/v1/inspections/${id}/photos`)
        .set(auth(inspectorToken))
        .send({ objectKey: presign.body.data.objectKey, caption: `photo ${i}` })
        .expect(201)
    }
  }

  async function submittedInspection(listingId: string, checklist = FULL_CHECKLIST) {
    const inspection = await createInspection(listingId)
    await startInspection(inspection.id)
    await request(app)
      .put(`/api/v1/inspections/${inspection.id}/checklist`)
      .set(auth(inspectorToken))
      .send({ items: checklist })
      .expect(200)
    await addPhotos(inspection.id, 3)
    await request(app)
      .post(`/api/v1/inspections/${inspection.id}/submit`)
      .set(auth(inspectorToken))
      .send({ inspectorNotes: 'Secret inspector notes' })
      .expect(200)
    return inspection
  }

  beforeEach(async () => {
    await listingStore.clear()
    await (propertyInspectionStore as InMemoryPropertyInspectionStore).clear()
    await (inspectorProfileStore as InMemoryInspectorProfileStore).clear()

    const inspector = await makeUser('inspector')
    inspectorToken = inspector.token
    inspectorId = inspector.id
    inspectorEmail = inspector.email
    await inspectorProfileStore.setVerificationStatus(inspector.id, 'verified')

    const other = await makeUser('inspector')
    otherInspectorToken = other.token
    await inspectorProfileStore.setVerificationStatus(other.id, 'verified')

    const admin = await makeUser('admin')
    adminToken = admin.token
    adminId = admin.id

    tenantToken = (await makeUser('tenant')).token
  })

  describe('create (verified inspectors only)', () => {
    it('requires authentication', async () => {
      const listing = await createListing()
      await request(app)
        .post('/api/v1/inspections')
        .send({ listingId: listing.listingId, scheduledAt: '2026-11-01T10:00:00Z' })
        .expect(401)
    })

    it('rejects a user with no inspector profile', async () => {
      const listing = await createListing()
      await request(app)
        .post('/api/v1/inspections')
        .set(auth(tenantToken))
        .send({ listingId: listing.listingId, scheduledAt: '2026-11-01T10:00:00Z' })
        .expect(403)
    })

    it('rejects pending and suspended inspectors', async () => {
      const listing = await createListing()
      const pending = await makeUser('inspector')
      await inspectorProfileStore.setVerificationStatus(pending.id, 'pending')
      await request(app)
        .post('/api/v1/inspections')
        .set(auth(pending.token))
        .send({ listingId: listing.listingId, scheduledAt: '2026-11-01T10:00:00Z' })
        .expect(403)

      await inspectorProfileStore.setVerificationStatus(pending.id, 'suspended')
      await request(app)
        .post('/api/v1/inspections')
        .set(auth(pending.token))
        .send({ listingId: listing.listingId, scheduledAt: '2026-11-01T10:00:00Z' })
        .expect(403)
    })

    it('creates a pending inspection assigned to the caller (both prefixes)', async () => {
      const listing = await createListing()
      const v1 = await createInspection(listing.listingId)
      expect(v1.status).toBe('pending')
      expect(v1.inspectorId).toBe(inspectorId)

      const legacy = await createInspection(listing.listingId, inspectorToken, '/api')
      expect(legacy.status).toBe('pending')
    })

    it('returns 404 for an unknown listing and 400 for an invalid body', async () => {
      await request(app)
        .post('/api/v1/inspections')
        .set(auth(inspectorToken))
        .send({ listingId: randomUUID(), scheduledAt: '2026-11-01T10:00:00Z' })
        .expect(404)
      await request(app)
        .post('/api/v1/inspections')
        .set(auth(inspectorToken))
        .send({ listingId: 'not-a-uuid' })
        .expect(400)
    })
  })

  describe('inspector verification (minimal #1902 subset)', () => {
    it('requires the inspectors:verify permission', async () => {
      const candidate = await makeUser('inspector')
      await request(app)
        .patch(`/api/v1/admin/inspectors/${candidate.id}/verification`)
        .set(auth(tenantToken))
        .send({ status: 'verified' })
        .expect(403)
      await request(app)
        .patch(`/api/v1/admin/inspectors/${candidate.id}/verification`)
        .send({ status: 'verified' })
        .expect(401)
    })

    it('lets an admin verify an inspector, who can then create inspections', async () => {
      const listing = await createListing()
      const candidate = await makeUser('inspector')
      await request(app)
        .post('/api/v1/inspections')
        .set(auth(candidate.token))
        .send({ listingId: listing.listingId, scheduledAt: '2026-11-01T10:00:00Z' })
        .expect(403)

      const res = await request(app)
        .patch(`/api/admin/inspectors/${candidate.id}/verification`)
        .set(auth(adminToken))
        .send({ status: 'verified' })
        .expect(200)
      expect(res.body.data.verificationStatus).toBe('verified')

      await createInspection(listing.listingId, candidate.token)
    })

    it('rejects an invalid verification status', async () => {
      await request(app)
        .patch(`/api/v1/admin/inspectors/${inspectorId}/verification`)
        .set(auth(adminToken))
        .send({ status: 'approved' })
        .expect(400)
    })
  })

  describe('assignment', () => {
    it('forbids a non-assigned verified inspector from every inspector action', async () => {
      const listing = await createListing()
      const inspection = await createInspection(listing.listingId)
      const base = `/api/v1/inspections/${inspection.id}`

      await request(app).patch(`${base}/start`).set(auth(otherInspectorToken)).expect(403)
      await startInspection(inspection.id)
      await request(app)
        .put(`${base}/checklist`)
        .set(auth(otherInspectorToken))
        .send({ items: FULL_CHECKLIST })
        .expect(403)
      await request(app)
        .post(`${base}/photos/presign`)
        .set(auth(otherInspectorToken))
        .send({ contentType: 'image/png' })
        .expect(403)
      await request(app)
        .post(`${base}/photos`)
        .set(auth(otherInspectorToken))
        .send({ objectKey: `inspection-reports/${inspection.id}/x.jpg` })
        .expect(403)
      await request(app).post(`${base}/submit`).set(auth(otherInspectorToken)).send({}).expect(403)
    })

    it('returns 404 for an unknown inspection', async () => {
      await request(app)
        .patch(`/api/v1/inspections/${randomUUID()}/start`)
        .set(auth(inspectorToken))
        .expect(404)
    })

    it('forbids the assigned inspector once suspended', async () => {
      const listing = await createListing()
      const inspection = await createInspection(listing.listingId)
      await inspectorProfileStore.setVerificationStatus(inspectorId, 'suspended')
      await request(app)
        .patch(`/api/v1/inspections/${inspection.id}/start`)
        .set(auth(inspectorToken))
        .expect(403)
    })
  })

  describe('status transitions', () => {
    it('blocks checklist, photos and submit before start', async () => {
      const listing = await createListing()
      const inspection = await createInspection(listing.listingId)
      const base = `/api/v1/inspections/${inspection.id}`

      const checklist = await request(app)
        .put(`${base}/checklist`)
        .set(auth(inspectorToken))
        .send({ items: FULL_CHECKLIST })
      expect(checklist.status).toBe(409)
      expect(checklist.body.error.code).toBe('INVALID_STATE_TRANSITION')

      await request(app)
        .post(`${base}/photos/presign`)
        .set(auth(inspectorToken))
        .send({ contentType: 'image/jpeg' })
        .expect(409)
      await request(app).post(`${base}/submit`).set(auth(inspectorToken)).send({}).expect(409)
    })

    it('moves pending -> in_progress once', async () => {
      const listing = await createListing()
      const inspection = await createInspection(listing.listingId)
      const res = await request(app)
        .patch(`/api/v1/inspections/${inspection.id}/start`)
        .set(auth(inspectorToken))
        .expect(200)
      expect(res.body.data.status).toBe('in_progress')
      await request(app)
        .patch(`/api/v1/inspections/${inspection.id}/start`)
        .set(auth(inspectorToken))
        .expect(409)
    })

    it('upserts checklist items by (category, item)', async () => {
      const listing = await createListing()
      const inspection = await createInspection(listing.listingId)
      await startInspection(inspection.id)
      const base = `/api/v1/inspections/${inspection.id}`

      await request(app)
        .put(`${base}/checklist`)
        .set(auth(inspectorToken))
        .send({ items: [{ category: 'plumbing', item: 'Kitchen sink', result: 'fail' }] })
        .expect(200)
      const res = await request(app)
        .put(`${base}/checklist`)
        .set(auth(inspectorToken))
        .send({
          items: [
            { category: 'plumbing', item: 'Kitchen sink', result: 'pass' },
            { category: 'safety', item: 'Smoke alarm', result: 'na' },
          ],
        })
        .expect(200)
      expect(res.body.data.items).toHaveLength(2)
      const sink = res.body.data.items.find((i: { item: string }) => i.item === 'Kitchen sink')
      expect(sink.result).toBe('pass')
    })

    it('rejects invalid checklist categories and results', async () => {
      const listing = await createListing()
      const inspection = await createInspection(listing.listingId)
      await startInspection(inspection.id)
      await request(app)
        .put(`/api/v1/inspections/${inspection.id}/checklist`)
        .set(auth(inspectorToken))
        .send({ items: [{ category: 'roof', item: 'Tiles', result: 'pass' }] })
        .expect(400)
      await request(app)
        .put(`/api/v1/inspections/${inspection.id}/checklist`)
        .set(auth(inspectorToken))
        .send({ items: [{ category: 'exterior', item: 'Tiles', result: 'ok' }] })
        .expect(400)
    })

    it('issues a presigned upload scoped to the inspection and rejects foreign keys', async () => {
      const listing = await createListing()
      const inspection = await createInspection(listing.listingId)
      await startInspection(inspection.id)
      const presign = await request(app)
        .post(`/api/v1/inspections/${inspection.id}/photos/presign`)
        .set(auth(inspectorToken))
        .send({ contentType: 'image/png' })
        .expect(200)
      expect(presign.body.data.objectKey).toMatch(
        new RegExp(`^inspection-reports/${inspection.id}/.+\\.png$`),
      )
      expect(presign.body.data.uploadUrl).toContain(presign.body.data.objectKey)

      await request(app)
        .post(`/api/v1/inspections/${inspection.id}/photos`)
        .set(auth(inspectorToken))
        .send({ objectKey: `inspection-reports/${randomUUID()}/x.png` })
        .expect(400)
      await request(app)
        .post(`/api/v1/inspections/${inspection.id}/photos/presign`)
        .set(auth(inspectorToken))
        .send({ contentType: 'application/pdf' })
        .expect(400)
    })

    it('requires at least one item per category to submit', async () => {
      const listing = await createListing()
      const inspection = await createInspection(listing.listingId)
      await startInspection(inspection.id)
      await request(app)
        .put(`/api/v1/inspections/${inspection.id}/checklist`)
        .set(auth(inspectorToken))
        .send({ items: FULL_CHECKLIST.filter((i) => i.category !== 'electrical') })
        .expect(200)
      await addPhotos(inspection.id, 3)

      const res = await request(app)
        .post(`/api/v1/inspections/${inspection.id}/submit`)
        .set(auth(inspectorToken))
        .send({})
        .expect(400)
      expect(res.body.error.details.missingCategories).toEqual(['electrical'])
    })

    it('requires at least three photos to submit', async () => {
      const listing = await createListing()
      const inspection = await createInspection(listing.listingId)
      await startInspection(inspection.id)
      await request(app)
        .put(`/api/v1/inspections/${inspection.id}/checklist`)
        .set(auth(inspectorToken))
        .send({ items: FULL_CHECKLIST })
        .expect(200)
      await addPhotos(inspection.id, 2)

      const res = await request(app)
        .post(`/api/v1/inspections/${inspection.id}/submit`)
        .set(auth(inspectorToken))
        .send({})
        .expect(400)
      expect(res.body.error.details.photoCount).toBe(2)
      expect(res.body.error.details.missingCategories).toEqual([])
    })

    it('submits, then blocks any further edits', async () => {
      const listing = await createListing()
      const inspection = await submittedInspection(listing.listingId)
      const base = `/api/v1/inspections/${inspection.id}`

      await request(app)
        .put(`${base}/checklist`)
        .set(auth(inspectorToken))
        .send({ items: FULL_CHECKLIST })
        .expect(409)
      await request(app)
        .post(`${base}/photos`)
        .set(auth(inspectorToken))
        .send({ objectKey: `inspection-reports/${inspection.id}/late.jpg` })
        .expect(409)
      await request(app)
        .post(`${base}/photos/presign`)
        .set(auth(inspectorToken))
        .send({ contentType: 'image/jpeg' })
        .expect(409)
      await request(app).post(`${base}/submit`).set(auth(inspectorToken)).send({}).expect(409)
      await request(app).patch(`${base}/start`).set(auth(inspectorToken)).expect(409)
    })
  })

  describe('admin review', () => {
    it('requires the inspections:review permission', async () => {
      const listing = await createListing()
      const inspection = await submittedInspection(listing.listingId)

      await request(app).post(`/api/v1/admin/inspections/${inspection.id}/approve`).expect(401)
      for (const token of [tenantToken, inspectorToken]) {
        await request(app)
          .post(`/api/v1/admin/inspections/${inspection.id}/approve`)
          .set(auth(token))
          .expect(403)
        await request(app)
          .post(`/api/v1/admin/inspections/${inspection.id}/reject`)
          .set(auth(token))
          .send({ reason: 'no' })
          .expect(403)
        await request(app).get('/api/v1/admin/inspections').set(auth(token)).expect(403)
      }
    })

    it('approves a submitted inspection and updates the listing trust flags', async () => {
      const listing = await createListing()
      const checklist = [
        ...FULL_CHECKLIST.filter((i) => i.category !== 'exterior'),
        { category: 'exterior' as const, item: 'Fence', result: 'fail' as const },
      ]
      const inspection = await submittedInspection(listing.listingId, checklist)

      const before = await listingStore.getById(listing.listingId)
      expect(before?.hasVerifiedInspection).toBeFalsy()

      const res = await request(app)
        .post(`/api/v1/admin/inspections/${inspection.id}/approve`)
        .set(auth(adminToken))
        .expect(200)

      // structural 3 + plumbing 2 + electrical 2 + safety 3 pass, exterior 1 fail -> 10/11
      expect(res.body.data.trustScore).toBe(91)
      expect(res.body.data.inspection.status).toBe('approved')
      expect(res.body.data.inspection.reviewedBy).toBe(adminId)

      const after = await listingStore.getById(listing.listingId)
      expect(after?.hasVerifiedInspection).toBe(true)
      expect(after?.trustScore).toBe(91)

      await request(app)
        .post(`/api/admin/inspections/${inspection.id}/approve`)
        .set(auth(adminToken))
        .expect(409)
    })

    it('cannot approve an inspection that has not been submitted', async () => {
      const listing = await createListing()
      const inspection = await createInspection(listing.listingId)
      await request(app)
        .post(`/api/v1/admin/inspections/${inspection.id}/approve`)
        .set(auth(adminToken))
        .expect(409)
      await startInspection(inspection.id)
      await request(app)
        .post(`/api/v1/admin/inspections/${inspection.id}/approve`)
        .set(auth(adminToken))
        .expect(409)
      const listingAfter = await listingStore.getById(listing.listingId)
      expect(listingAfter?.hasVerifiedInspection).toBeFalsy()
    })

    it('rejects with a reason and leaves the listing untouched', async () => {
      const listing = await createListing()
      const inspection = await submittedInspection(listing.listingId)

      await request(app)
        .post(`/api/v1/admin/inspections/${inspection.id}/reject`)
        .set(auth(adminToken))
        .send({})
        .expect(400)

      const res = await request(app)
        .post(`/api/v1/admin/inspections/${inspection.id}/reject`)
        .set(auth(adminToken))
        .send({ reason: 'Photos are blurry' })
        .expect(200)
      expect(res.body.data.status).toBe('rejected')
      expect(res.body.data.rejectionReason).toBe('Photos are blurry')

      const after = await listingStore.getById(listing.listingId)
      expect(after?.hasVerifiedInspection).toBeFalsy()

      await request(app)
        .post(`/api/v1/admin/inspections/${inspection.id}/approve`)
        .set(auth(adminToken))
        .expect(409)
      await request(app)
        .post(`/api/v1/admin/inspections/${inspection.id}/reject`)
        .set(auth(adminToken))
        .send({ reason: 'again' })
        .expect(409)
    })

    it('lists the review queue and returns inspection detail', async () => {
      const listing = await createListing()
      const inspection = await submittedInspection(listing.listingId)
      await createInspection(listing.listingId)

      const list = await request(app)
        .get('/api/v1/admin/inspections?status=submitted')
        .set(auth(adminToken))
        .expect(200)
      expect(list.body.data.map((i: { id: string }) => i.id)).toEqual([inspection.id])

      const detail = await request(app)
        .get(`/api/v1/admin/inspections/${inspection.id}`)
        .set(auth(adminToken))
        .expect(200)
      expect(detail.body.data.items).toHaveLength(INSPECTION_CATEGORIES.length)
      expect(detail.body.data.photos).toHaveLength(3)
    })
  })

  describe('public summary', () => {
    it('returns 404 until an inspection is approved', async () => {
      const listing = await createListing()
      await request(app).get(`/api/v1/listings/${listing.listingId}/inspection`).expect(404)
      await submittedInspection(listing.listingId)
      await request(app).get(`/api/v1/listings/${listing.listingId}/inspection`).expect(404)
    })

    it('returns 404 for a listing that is not publicly visible', async () => {
      const listing = await createListing(false)
      await request(app).get(`/api/v1/listings/${listing.listingId}/inspection`).expect(404)
    })

    it('summarises the latest approved inspection without inspector PII', async () => {
      const listing = await createListing()
      const inspection = await submittedInspection(listing.listingId)
      await request(app)
        .post(`/api/v1/admin/inspections/${inspection.id}/approve`)
        .set(auth(adminToken))
        .expect(200)

      for (const prefix of ['/api/v1', '/api']) {
        const res = await request(app)
          .get(`${prefix}/listings/${listing.listingId}/inspection`)
          .expect(200)

        const data = res.body.data
        expect(data.inspectionId).toBe(inspection.id)
        expect(data.trustScore).toBe(100)
        expect(data.hasVerifiedInspection).toBe(true)
        expect(data.photoCount).toBe(3)
        expect(data.categories).toHaveLength(INSPECTION_CATEGORIES.length)
        expect(data.categories[0]).toEqual({ category: 'structural', pass: 1, fail: 0, na: 0 })

        const raw = JSON.stringify(res.body)
        expect(raw).not.toContain(inspectorId)
        expect(raw).not.toContain(inspectorEmail)
        expect(raw).not.toContain(adminId)
        expect(raw).not.toContain('Secret inspector notes')
        expect(raw).not.toContain('Private inspector note')
        expect(raw).not.toContain('inspectorId')
        expect(raw).not.toContain('reviewedBy')
      }
    })

    it('does not shadow the existing public listing detail route', async () => {
      const listing = await createListing()
      const res = await request(app).get(`/api/listings/${listing.listingId}`).expect(200)
      expect(res.body.data.listingId).toBe(listing.listingId)
    })
  })
})

describe('Property inspections app.ts mounting', () => {
  const app = createApp()

  it('mounts the inspector, admin and public routes under /api/v1 and /api', async () => {
    for (const prefix of ['/api/v1', '/api']) {
      await request(app).post(`${prefix}/inspections`).send({}).expect(401)
      await request(app).post(`${prefix}/admin/inspections/${randomUUID()}/approve`).expect(401)
      await request(app)
        .patch(`${prefix}/admin/inspectors/someone/verification`)
        .send({ status: 'verified' })
        .expect(401)
      const res = await request(app).get(`${prefix}/listings/${randomUUID()}/inspection`)
      expect(res.status).toBe(404)
      expect(res.body.error.message).toBe('Property not found')
    }
  })
})
