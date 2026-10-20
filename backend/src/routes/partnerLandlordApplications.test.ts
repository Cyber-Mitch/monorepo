import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import express from 'express'
import {
  createPartnerLandlordApplicationsRouter,
  createAdminPartnerApplicationsRouter,
} from './partnerLandlordApplications.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'
import {
  InMemoryPartnerLandlordApplicationStore,
  initPartnerLandlordApplicationStore,
} from '../models/partnerLandlordApplicationStore.js'
import { sessionStore, userStore } from '../models/authStore.js'

const validPayload = {
  fullName: 'Chidi Okafor',
  phone: '08031234567',
  email: 'Chidi@Example.com',
  propertyCount: 3,
  propertyLocations: 'Lekki, Yaba',
}

describe('Partner landlord applications (#1909)', () => {
  let app: express.Application
  let store: InMemoryPartnerLandlordApplicationStore
  let adminToken: string
  let tenantToken: string

  beforeEach(async () => {
    store = new InMemoryPartnerLandlordApplicationStore()
    initPartnerLandlordApplicationStore(store)
    userStore.clear()
    sessionStore.clear()

    const admin = await userStore.getOrCreateByEmail('pla-admin@example.com')
    admin.role = 'admin'
    adminToken = (await sessionStore.create('pla-admin@example.com', 'pla-admin-token')).token
    await userStore.getOrCreateByEmail('pla-tenant@example.com')
    tenantToken = (await sessionStore.create('pla-tenant@example.com', 'pla-tenant-token')).token

    app = express()
    app.use(requestIdMiddleware)
    app.use(express.json())
    app.use('/api/v1/landlord/partner-application', createPartnerLandlordApplicationsRouter())
    app.use('/api/v1/admin/partner-applications', createAdminPartnerApplicationsRouter())
    app.use(errorHandler)
  })

  describe('POST /landlord/partner-application', () => {
    it('persists a valid application (public, no auth) with normalised email and phone', async () => {
      const res = await request(app)
        .post('/api/v1/landlord/partner-application')
        .send(validPayload)
        .expect(201)

      expect(res.body.application.status).toBe('pending')

      const { applications } = await store.list()
      expect(applications).toHaveLength(1)
      expect(applications[0]).toMatchObject({
        email: 'chidi@example.com',
        phone: '+2348031234567',
        propertyCount: 3,
        propertyLocations: 'Lekki, Yaba',
      })
    })

    it.each(['08031234567', '+2348031234567', '2348031234567', '0803 123 4567'])(
      'accepts Nigerian phone format %s',
      async (phone) => {
        await request(app)
          .post('/api/v1/landlord/partner-application')
          .send({ ...validPayload, phone })
          .expect(201)
      },
    )

    it.each(['12345', '+14155552671', '0603123456', 'not-a-phone'])(
      'rejects non-Nigerian phone %s',
      async (phone) => {
        await request(app)
          .post('/api/v1/landlord/partner-application')
          .send({ ...validPayload, phone })
          .expect(400)
        expect((await store.list()).total).toBe(0)
      },
    )

    it.each([0, -1, 1.5, '3'])('rejects propertyCount %s', async (propertyCount) => {
      await request(app)
        .post('/api/v1/landlord/partner-application')
        .send({ ...validPayload, propertyCount })
        .expect(400)
    })

    it('rejects an invalid email', async () => {
      await request(app)
        .post('/api/v1/landlord/partner-application')
        .send({ ...validPayload, email: 'nope' })
        .expect(400)
    })

    it('rejects a duplicate email within 24h with 409 (case-insensitive)', async () => {
      await request(app).post('/api/v1/landlord/partner-application').send(validPayload).expect(201)
      const res = await request(app)
        .post('/api/v1/landlord/partner-application')
        .send({ ...validPayload, email: 'CHIDI@example.com' })
        .expect(409)
      expect(JSON.stringify(res.body)).toMatch(/already received/)
      expect((await store.list()).total).toBe(1)
    })

    it('accepts the same email again once the 24h window has passed', async () => {
      const first = await store.create({ ...validPayload, email: 'chidi@example.com', phone: '+2348031234567' })
      ;(first as { createdAt: Date }).createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000)
      await request(app).post('/api/v1/landlord/partner-application').send(validPayload).expect(201)
      expect((await store.list()).total).toBe(2)
    })
  })

  describe('admin endpoints', () => {
    it('requires authentication', async () => {
      await request(app).get('/api/v1/admin/partner-applications').expect(401)
    })

    it('forbids non-admins', async () => {
      await request(app)
        .get('/api/v1/admin/partner-applications')
        .set('Authorization', `Bearer ${tenantToken}`)
        .expect(403)
      await request(app)
        .patch('/api/v1/admin/partner-applications/PLA-1')
        .set('Authorization', `Bearer ${tenantToken}`)
        .send({ status: 'approved' })
        .expect(403)
    })

    it('lists submissions and filters by status', async () => {
      await request(app).post('/api/v1/landlord/partner-application').send(validPayload).expect(201)
      await request(app)
        .post('/api/v1/landlord/partner-application')
        .send({ ...validPayload, email: 'second@example.com' })
        .expect(201)
      const [first] = (await store.list()).applications
      await store.update(first!.id, { status: 'contacted', reviewedBy: 'someone' })

      const all = await request(app)
        .get('/api/v1/admin/partner-applications')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
      expect(all.body.total).toBe(2)

      const contacted = await request(app)
        .get('/api/v1/admin/partner-applications?status=contacted')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
      expect(contacted.body.applications).toHaveLength(1)
      expect(contacted.body.applications[0].status).toBe('contacted')

      await request(app)
        .get('/api/v1/admin/partner-applications?status=bogus')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400)
    })

    it('PATCH records status, notes, reviewer and review time', async () => {
      const created = await request(app)
        .post('/api/v1/landlord/partner-application')
        .send(validPayload)
        .expect(201)
      const id = created.body.application.id as string

      const res = await request(app)
        .patch(`/api/v1/admin/partner-applications/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'approved', notes: 'Called, 3 flats in Lekki verified' })
        .expect(200)

      expect(res.body.application).toMatchObject({
        id,
        status: 'approved',
        notes: 'Called, 3 flats in Lekki verified',
      })
      expect(res.body.application.reviewedBy).toBeTruthy()
      expect(res.body.application.reviewedAt).toBeTruthy()
    })

    it('PATCH validates input and 404s unknown ids', async () => {
      await request(app)
        .patch('/api/v1/admin/partner-applications/PLA-missing')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'approved' })
        .expect(404)
      await request(app)
        .patch('/api/v1/admin/partner-applications/PLA-missing')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'pending-ish' })
        .expect(400)
      await request(app)
        .patch('/api/v1/admin/partner-applications/PLA-missing')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(400)
    })
  })
})
