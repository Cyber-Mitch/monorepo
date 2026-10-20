import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createLandlordPayoutScheduleRouter } from './landlordPayoutSchedule.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'
import { sessionStore, userStore } from '../models/authStore.js'
import {
  InMemoryLandlordPayoutScheduleStore,
  initLandlordPayoutScheduleStore,
} from '../models/landlordPayoutScheduleStore.js'
import type { LandlordPayout } from '../schemas/landlordPayoutSchedule.js'

function buildApp(): express.Express {
  const app = express()
  app.use(requestIdMiddleware)
  app.use(express.json())
  app.use('/api/v1/landlord/payout-schedule', createLandlordPayoutScheduleRouter())
  app.use(errorHandler)
  return app
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

function payout(id: string, landlordId: string, overrides: Partial<LandlordPayout> = {}): LandlordPayout {
  const stamp = '2026-01-10T09:00:00.000Z'
  return {
    id,
    landlordId,
    propertyId: 'prop-1',
    propertyName: 'Lekki Flat',
    scheduledDate: stamp,
    completedDate: null,
    grossAmount: 1000,
    deductions: [{ type: 'platform_fee', label: 'Platform Fee', amount: 100 }],
    netAmount: 900,
    currency: 'NGN',
    status: 'scheduled',
    channel: 'bank_transfer',
    delayReasons: [],
    periodStart: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-01-31T23:59:59.999Z',
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  }
}

describe('Landlord payout schedule routes (#1892)', () => {
  let app: express.Express
  let store: InMemoryLandlordPayoutScheduleStore
  let landlordId: string
  let landlordToken: string
  let otherLandlordId: string
  let otherLandlordToken: string
  let tenantToken: string

  beforeEach(async () => {
    store = new InMemoryLandlordPayoutScheduleStore()
    initLandlordPayoutScheduleStore(store)
    sessionStore.clear()
    userStore.clear()
    app = buildApp()

    const landlord = await userStore.getOrCreateByEmail('payout-landlord@example.com')
    landlord.role = 'landlord'
    landlordId = landlord.id
    landlordToken = 'test-token-payout-landlord'
    await sessionStore.create(landlord.email, landlordToken)

    const other = await userStore.getOrCreateByEmail('payout-other-landlord@example.com')
    other.role = 'landlord'
    otherLandlordId = other.id
    otherLandlordToken = 'test-token-payout-other-landlord'
    await sessionStore.create(other.email, otherLandlordToken)

    const tenant = await userStore.getOrCreateByEmail('payout-tenant@example.com')
    tenantToken = 'test-token-payout-tenant'
    await sessionStore.create(tenant.email, tenantToken)
  })

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/landlord/payout-schedule')
    expect(res.status).toBe(401)
  })

  it('forbids a non-landlord caller', async () => {
    const res = await request(app).get('/api/v1/landlord/payout-schedule').set(auth(tenantToken))
    expect(res.status).toBe(403)
  })

  describe('GET /api/v1/landlord/payout-schedule', () => {
    it('returns periods and a summary for the landlord only', async () => {
      store.add(payout('PAY-1', landlordId, { scheduledDate: '2026-01-10T09:00:00.000Z' }))
      store.add(payout('PAY-2', landlordId, {
        scheduledDate: '2026-02-03T09:00:00.000Z',
        status: 'delayed',
        delayReasons: ['bank_processing'],
      }))
      store.add(payout('PAY-OTHER', otherLandlordId, { scheduledDate: '2026-01-11T09:00:00.000Z' }))

      const res = await request(app)
        .get('/api/v1/landlord/payout-schedule?grouping=monthly')
        .set(auth(landlordToken))

      expect(res.status).toBe(200)
      expect(res.body.data.periods.map((p: { periodLabel: string }) => p.periodLabel)).toEqual([
        '2026-01',
        '2026-02',
      ])
      expect(res.body.data.summary).toMatchObject({
        totalGross: 2000,
        totalDeductions: 200,
        totalNet: 1800,
        totalPayouts: 2,
        delayedPayouts: 1,
      })
    })

    it('applies the status filter before grouping and summing', async () => {
      store.add(payout('PAY-1', landlordId, { status: 'completed' }))
      store.add(payout('PAY-2', landlordId, { status: 'on_hold' }))

      const res = await request(app)
        .get('/api/v1/landlord/payout-schedule?status=on_hold')
        .set(auth(landlordToken))

      expect(res.body.data.summary.totalPayouts).toBe(1)
      expect(res.body.data.periods[0].payouts.map((p: { id: string }) => p.id)).toEqual(['PAY-2'])
    })

    it('rejects an unknown grouping value', async () => {
      const res = await request(app)
        .get('/api/v1/landlord/payout-schedule?grouping=daily')
        .set(auth(landlordToken))
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/v1/landlord/payout-schedule/payouts', () => {
    it('paginates and reports totals', async () => {
      for (let i = 1; i <= 5; i++) {
        store.add(payout(`PAY-${i}`, landlordId, {
          scheduledDate: `2026-01-${String(i).padStart(2, '0')}T09:00:00.000Z`,
        }))
      }

      const res = await request(app)
        .get('/api/v1/landlord/payout-schedule/payouts?page=2&pageSize=2')
        .set(auth(landlordToken))

      expect(res.status).toBe(200)
      expect(res.body.data.map((p: { id: string }) => p.id)).toEqual(['PAY-3', 'PAY-4'])
      expect(res.body.pagination).toEqual({ total: 5, page: 2, pageSize: 2, totalPages: 3 })
    })

    it('rejects page 0', async () => {
      const res = await request(app)
        .get('/api/v1/landlord/payout-schedule/payouts?page=0')
        .set(auth(landlordToken))
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/v1/landlord/payout-schedule/:payoutId', () => {
    it('returns the payout to its landlord', async () => {
      store.add(payout('PAY-1', landlordId))

      const res = await request(app)
        .get('/api/v1/landlord/payout-schedule/PAY-1')
        .set(auth(landlordToken))

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ id: 'PAY-1', landlordId, netAmount: 900 })
    })

    it('returns 404 for another landlord\'s payout', async () => {
      store.add(payout('PAY-OTHER', otherLandlordId))

      const res = await request(app)
        .get('/api/v1/landlord/payout-schedule/PAY-OTHER')
        .set(auth(landlordToken))

      expect(res.status).toBe(404)
    })
  })

  describe('schedule preference', () => {
    it('defaults to monthly and round-trips an update', async () => {
      const before = await request(app)
        .get('/api/v1/landlord/payout-schedule/preference')
        .set(auth(landlordToken))
      expect(before.body.data).toEqual({ schedulePreference: 'monthly' })

      const put = await request(app)
        .put('/api/v1/landlord/payout-schedule/preference')
        .set(auth(landlordToken))
        .send({ schedulePreference: 'weekly' })
      expect(put.status).toBe(200)

      const after = await request(app)
        .get('/api/v1/landlord/payout-schedule/preference')
        .set(auth(landlordToken))
      expect(after.body.data).toEqual({ schedulePreference: 'weekly' })
    })

    it('rejects an unknown preference', async () => {
      const res = await request(app)
        .put('/api/v1/landlord/payout-schedule/preference')
        .set(auth(landlordToken))
        .send({ schedulePreference: 'daily' })
      expect(res.status).toBe(400)
    })
  })
})
