import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import {
  createInspectorOnboardingRouter,
  createAdminInspectorManagementRouter,
} from './inspectorOnboarding.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'
import { sessionStore, userStore } from '../models/authStore.js'
import {
  InMemoryInspectorProfileStore,
  initInspectorProfileStore,
  inspectorProfileStore,
} from '../models/inspectorProfileStore.js'
import { kycRepository } from '../repositories/KycRepository.js'
import { notificationService } from '../services/notificationService.js'
import * as auditLogger from '../utils/auditLogger.js'

function buildApp(): express.Express {
  const app = express()
  app.use(requestIdMiddleware)
  app.use(express.json())
  app.use('/api/v1/inspector', createInspectorOnboardingRouter())
  app.use('/api/v1/admin/inspectors', createAdminInspectorManagementRouter())
  app.use(errorHandler)
  return app
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

const VALID_ONBOARDING = {
  bio: 'Five years of residential property inspections in Lagos.',
  serviceAreas: ['Lagos', 'Ibadan'],
}

describe('Inspector onboarding and verification (#1902)', () => {
  let app: express.Express
  let inspectorId: string
  let inspectorToken: string
  let otherUserToken: string
  let adminToken: string
  let auditSpy: ReturnType<typeof vi.spyOn>
  let notifySpy: ReturnType<typeof vi.spyOn>
  let kycSpy: ReturnType<typeof vi.spyOn>

  function auditEvents(): string[] {
    return auditSpy.mock.calls.map((call: unknown[]) => call[0] as string)
  }

  beforeEach(async () => {
    vi.restoreAllMocks()
    initInspectorProfileStore(new InMemoryInspectorProfileStore())
    sessionStore.clear()
    userStore.clear()
    app = buildApp()

    auditSpy = vi.spyOn(auditLogger, 'auditLog')
    notifySpy = vi.spyOn(notificationService, 'create').mockResolvedValue('notification-id')
    kycSpy = vi.spyOn(kycRepository, 'findByUserId').mockResolvedValue({ status: 'approved' } as any)

    const inspector = await userStore.getOrCreateByEmail('inspector-applicant@example.com')
    inspectorId = inspector.id
    inspectorToken = 'test-token-inspector-applicant'
    await sessionStore.create(inspector.email, inspectorToken)

    const other = await userStore.getOrCreateByEmail('inspector-other@example.com')
    otherUserToken = 'test-token-inspector-other'
    await sessionStore.create(other.email, otherUserToken)

    const admin = await userStore.getOrCreateByEmail('inspector-admin@example.com')
    admin.role = 'admin'
    adminToken = 'test-token-inspector-admin'
    await sessionStore.create(admin.email, adminToken)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('POST /api/v1/inspector/onboarding', () => {
    it('requires authentication', async () => {
      const res = await request(app).post('/api/v1/inspector/onboarding').send(VALID_ONBOARDING)
      expect(res.status).toBe(401)
    })

    it('rejects a service area outside the supported list', async () => {
      const res = await request(app)
        .post('/api/v1/inspector/onboarding')
        .set(auth(inspectorToken))
        .send({ ...VALID_ONBOARDING, serviceAreas: ['Lagos', 'Mars'] })

      expect(res.status).toBe(400)
      expect(await inspectorProfileStore.getByUserId(inspectorId)).toBeNull()
    })

    it('rejects duplicate service areas', async () => {
      const res = await request(app)
        .post('/api/v1/inspector/onboarding')
        .set(auth(inspectorToken))
        .send({ ...VALID_ONBOARDING, serviceAreas: ['Lagos', 'Lagos'] })

      expect(res.status).toBe(400)
    })

    it('rejects an empty bio and an empty service area list', async () => {
      const noBio = await request(app)
        .post('/api/v1/inspector/onboarding')
        .set(auth(inspectorToken))
        .send({ ...VALID_ONBOARDING, bio: '   ' })
      const noAreas = await request(app)
        .post('/api/v1/inspector/onboarding')
        .set(auth(inspectorToken))
        .send({ ...VALID_ONBOARDING, serviceAreas: [] })

      expect(noBio.status).toBe(400)
      expect(noAreas.status).toBe(400)
    })

    it('creates a pending profile and audits the submission', async () => {
      const res = await request(app)
        .post('/api/v1/inspector/onboarding')
        .set(auth(inspectorToken))
        .send(VALID_ONBOARDING)

      expect(res.status).toBe(201)
      expect(res.body.data).toMatchObject({
        userId: inspectorId,
        verificationStatus: 'pending',
        bio: VALID_ONBOARDING.bio,
        serviceAreas: ['Lagos', 'Ibadan'],
      })
      expect(auditEvents()).toContain('INSPECTOR_ONBOARDING_SUBMITTED')
    })

    it('updates the profile while it is pending', async () => {
      await request(app).post('/api/v1/inspector/onboarding').set(auth(inspectorToken)).send(VALID_ONBOARDING)

      const res = await request(app)
        .post('/api/v1/inspector/onboarding')
        .set(auth(inspectorToken))
        .send({ bio: 'Updated bio', serviceAreas: ['Abuja'] })

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({
        verificationStatus: 'pending',
        bio: 'Updated bio',
        serviceAreas: ['Abuja'],
      })
    })

    it('refuses to re-onboard a suspended inspector', async () => {
      await request(app).post('/api/v1/inspector/onboarding').set(auth(inspectorToken)).send(VALID_ONBOARDING)
      await request(app)
        .post(`/api/v1/admin/inspectors/${inspectorId}/suspend`)
        .set(auth(adminToken))

      const res = await request(app)
        .post('/api/v1/inspector/onboarding')
        .set(auth(inspectorToken))
        .send(VALID_ONBOARDING)

      expect(res.status).toBe(403)
      expect((await inspectorProfileStore.getByUserId(inspectorId))?.verificationStatus).toBe('suspended')
    })

    it('refuses to reset a verified profile back to pending', async () => {
      await request(app).post('/api/v1/inspector/onboarding').set(auth(inspectorToken)).send(VALID_ONBOARDING)
      await request(app)
        .post(`/api/v1/admin/inspectors/${inspectorId}/verify`)
        .set(auth(adminToken))

      const res = await request(app)
        .post('/api/v1/inspector/onboarding')
        .set(auth(inspectorToken))
        .send(VALID_ONBOARDING)

      expect(res.status).toBe(409)
      expect((await inspectorProfileStore.getByUserId(inspectorId))?.verificationStatus).toBe('verified')
    })
  })

  describe('GET /api/v1/inspector/me', () => {
    it('returns 404 before onboarding', async () => {
      const res = await request(app).get('/api/v1/inspector/me').set(auth(inspectorToken))
      expect(res.status).toBe(404)
    })

    it('returns the profile and status after onboarding', async () => {
      await request(app).post('/api/v1/inspector/onboarding').set(auth(inspectorToken)).send(VALID_ONBOARDING)

      const res = await request(app).get('/api/v1/inspector/me').set(auth(inspectorToken))

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ userId: inspectorId, verificationStatus: 'pending' })
    })
  })

  describe('admin verify / suspend', () => {
    beforeEach(async () => {
      await request(app).post('/api/v1/inspector/onboarding').set(auth(inspectorToken)).send(VALID_ONBOARDING)
    })

    it('forbids a caller without inspectors:manage', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/inspectors/${inspectorId}/verify`)
        .set(auth(otherUserToken))

      expect(res.status).toBe(403)
      expect((await inspectorProfileStore.getByUserId(inspectorId))?.verificationStatus).toBe('pending')
    })

    it('blocks verification until KYC is approved', async () => {
      kycSpy.mockResolvedValue({ status: 'in_review' } as any)

      const res = await request(app)
        .post(`/api/v1/admin/inspectors/${inspectorId}/verify`)
        .set(auth(adminToken))

      expect(res.status).toBe(409)
      expect((await inspectorProfileStore.getByUserId(inspectorId))?.verificationStatus).toBe('pending')
      expect(notifySpy).not.toHaveBeenCalled()
    })

    it('blocks verification when no KYC record exists', async () => {
      kycSpy.mockResolvedValue(null as any)

      const res = await request(app)
        .post(`/api/v1/admin/inspectors/${inspectorId}/verify`)
        .set(auth(adminToken))

      expect(res.status).toBe(409)
    })

    it('verifies an approved inspector, audits it and notifies them', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/inspectors/${inspectorId}/verify`)
        .set(auth(adminToken))

      expect(res.status).toBe(200)
      expect(res.body.data.verificationStatus).toBe('verified')
      expect(auditEvents()).toContain('INSPECTOR_VERIFIED')
      expect(notifySpy).toHaveBeenCalledWith(inspectorId, expect.objectContaining({ category: 'inspector' }))
    })

    it('treats verifying an already verified inspector as a no-op', async () => {
      await request(app).post(`/api/v1/admin/inspectors/${inspectorId}/verify`).set(auth(adminToken))
      notifySpy.mockClear()

      const res = await request(app)
        .post(`/api/v1/admin/inspectors/${inspectorId}/verify`)
        .set(auth(adminToken))

      expect(res.status).toBe(200)
      expect(notifySpy).not.toHaveBeenCalled()
    })

    it('suspends an inspector and notifies them', async () => {
      await request(app).post(`/api/v1/admin/inspectors/${inspectorId}/verify`).set(auth(adminToken))

      const res = await request(app)
        .post(`/api/v1/admin/inspectors/${inspectorId}/suspend`)
        .set(auth(adminToken))

      expect(res.status).toBe(200)
      expect(res.body.data.verificationStatus).toBe('suspended')
      expect(auditEvents()).toContain('INSPECTOR_SUSPENDED')
    })

    it('returns 404 for an unknown inspector', async () => {
      const res = await request(app)
        .post('/api/v1/admin/inspectors/no-such-user/verify')
        .set(auth(adminToken))

      expect(res.status).toBe(404)
    })

    it('still succeeds when the notification fails', async () => {
      notifySpy.mockRejectedValue(new Error('notification backend down'))

      const res = await request(app)
        .post(`/api/v1/admin/inspectors/${inspectorId}/verify`)
        .set(auth(adminToken))

      expect(res.status).toBe(200)
      expect((await inspectorProfileStore.getByUserId(inspectorId))?.verificationStatus).toBe('verified')
    })
  })

  describe('GET /api/v1/admin/inspectors', () => {
    it('lists profiles filtered by status', async () => {
      await request(app).post('/api/v1/inspector/onboarding').set(auth(inspectorToken)).send(VALID_ONBOARDING)
      await request(app).post(`/api/v1/admin/inspectors/${inspectorId}/verify`).set(auth(adminToken))

      const pending = await request(app)
        .get('/api/v1/admin/inspectors?status=pending')
        .set(auth(adminToken))
      const verified = await request(app)
        .get('/api/v1/admin/inspectors?status=verified')
        .set(auth(adminToken))

      expect(pending.status).toBe(200)
      expect(pending.body.data).toEqual([])
      expect(verified.body.data.map((p: { userId: string }) => p.userId)).toEqual([inspectorId])
    })

    it('rejects an unknown status filter', async () => {
      const res = await request(app)
        .get('/api/v1/admin/inspectors?status=banned')
        .set(auth(adminToken))

      expect(res.status).toBe(400)
    })

    it('forbids a non-admin caller', async () => {
      const res = await request(app).get('/api/v1/admin/inspectors').set(auth(otherUserToken))
      expect(res.status).toBe(403)
    })
  })
})
