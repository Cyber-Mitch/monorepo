import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createTenantCreditScoreRouter, createAdminCreditScoreRouter } from './tenantCreditScore.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { creditScoreSnapshotStore } from '../models/creditScoreSnapshot.js'

function buildApp(): express.Express {
  const app = express()
  app.use(requestIdMiddleware)
  app.use(express.json())
  app.use('/api/v1/tenant/credit-score', createTenantCreditScoreRouter())
  app.use('/api/v1/admin/credit-score', createAdminCreditScoreRouter())
  app.use(errorHandler)
  return app
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

describe('Tenant credit score routes (#1901)', () => {
  let app: express.Express
  let tenantId: string
  let tenantToken: string
  let otherTenantId: string
  let otherTenantToken: string
  let adminToken: string

  beforeEach(async () => {
    await creditScoreSnapshotStore.clear()
    sessionStore.clear()
    userStore.clear()
    app = buildApp()

    const tenant = await userStore.getOrCreateByEmail('score-tenant@example.com')
    tenantId = tenant.id
    tenantToken = 'test-token-score-tenant'
    await sessionStore.create(tenant.email, tenantToken)

    const other = await userStore.getOrCreateByEmail('score-other@example.com')
    otherTenantId = other.id
    otherTenantToken = 'test-token-score-other'
    await sessionStore.create(other.email, otherTenantToken)

    const admin = await userStore.getOrCreateByEmail('score-admin@example.com')
    admin.role = 'admin'
    adminToken = 'test-token-score-admin'
    await sessionStore.create(admin.email, adminToken)
  })

  async function snapshot(
    userId: string,
    score: number,
    computedAt: string,
    factors: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; weight: number; detail: string }> = [],
  ) {
    const band = score <= 39 ? 'poor' : score <= 59 ? 'fair' : score <= 79 ? 'good' : 'excellent'
    return creditScoreSnapshotStore.create({
      userId,
      score,
      band,
      factors,
      computedAt: new Date(computedAt),
    })
  }

  describe('GET /api/v1/tenant/credit-score', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/api/v1/tenant/credit-score')
      expect(res.status).toBe(401)
    })

    it('returns 404 NO_SCORE_YET when the tenant has never been scored', async () => {
      const res = await request(app).get('/api/v1/tenant/credit-score').set(auth(tenantToken))

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NO_SCORE_YET')
    })

    it('returns the latest snapshot with tips for failing and warning factors', async () => {
      await snapshot(tenantId, 45, '2026-01-01T00:00:00.000Z')
      await snapshot(tenantId, 62, '2026-03-01T00:00:00.000Z', [
        { name: 'income_ratio', status: 'fail', weight: 30, detail: 'Income is below 3x rent' },
        { name: 'employment', status: 'warn', weight: 10, detail: 'Employment is under 6 months' },
        { name: 'kyc', status: 'pass', weight: 20, detail: 'KYC approved' },
      ])

      const res = await request(app).get('/api/v1/tenant/credit-score').set(auth(tenantToken))

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({
        score: 62,
        band: 'good',
        computedAt: '2026-03-01T00:00:00.000Z',
      })
      expect(res.body.data.factors).toHaveLength(3)
      expect(res.body.data.tips).toEqual([
        'Improve income ratio: Income is below 3x rent',
        'Strengthen employment: Employment is under 6 months',
      ])
    })

    it('never returns another tenant score', async () => {
      await snapshot(otherTenantId, 90, '2026-03-01T00:00:00.000Z')

      const res = await request(app).get('/api/v1/tenant/credit-score').set(auth(tenantToken))

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NO_SCORE_YET')
    })
  })

  describe('GET /api/v1/tenant/credit-score/history', () => {
    it('lists snapshots newest first', async () => {
      await snapshot(tenantId, 40, '2026-01-01T00:00:00.000Z')
      await snapshot(tenantId, 55, '2026-02-01T00:00:00.000Z')
      await snapshot(tenantId, 70, '2026-03-01T00:00:00.000Z')

      const res = await request(app)
        .get('/api/v1/tenant/credit-score/history')
        .set(auth(tenantToken))

      expect(res.status).toBe(200)
      expect(res.body.data.map((s: { score: number }) => s.score)).toEqual([70, 55, 40])
      expect(res.body.data[0]).toEqual({
        score: 70,
        band: 'good',
        computedAt: '2026-03-01T00:00:00.000Z',
      })
    })

    it('honours the limit query parameter', async () => {
      await snapshot(tenantId, 40, '2026-01-01T00:00:00.000Z')
      await snapshot(tenantId, 55, '2026-02-01T00:00:00.000Z')
      await snapshot(tenantId, 70, '2026-03-01T00:00:00.000Z')

      const res = await request(app)
        .get('/api/v1/tenant/credit-score/history?limit=2')
        .set(auth(tenantToken))

      expect(res.status).toBe(200)
      expect(res.body.data.map((s: { score: number }) => s.score)).toEqual([70, 55])
    })

    it('rejects an out-of-range limit', async () => {
      const res = await request(app)
        .get('/api/v1/tenant/credit-score/history?limit=500')
        .set(auth(tenantToken))

      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/v1/admin/credit-score/:userId', () => {
    it('returns the latest score for any user to an admin', async () => {
      await snapshot(tenantId, 81, '2026-03-01T00:00:00.000Z')

      const res = await request(app)
        .get(`/api/v1/admin/credit-score/${tenantId}`)
        .set(auth(adminToken))

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ userId: tenantId, score: 81, band: 'excellent' })
    })

    it('rejects a tenant without the underwriting:view permission', async () => {
      await snapshot(tenantId, 81, '2026-03-01T00:00:00.000Z')

      const res = await request(app)
        .get(`/api/v1/admin/credit-score/${tenantId}`)
        .set(auth(tenantToken))

      expect(res.status).toBe(403)
    })

    it('requires authentication', async () => {
      const res = await request(app).get(`/api/v1/admin/credit-score/${tenantId}`)
      expect(res.status).toBe(401)
    })
  })
})
