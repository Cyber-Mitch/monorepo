import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createUserErasureRouter, createAdminErasureRouter } from './erasure.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'
import { otpChallengeStore, sessionStore, userStore } from '../models/authStore.js'
import {
  InMemoryErasureRequestStore,
  erasureRequestStore,
  initErasureRequestStore,
} from '../models/erasureRequestStore.js'
import { dealStore } from '../models/dealStore.js'
import { DealStatus } from '../models/deal.js'
import {
  createDefaultErasureEligibilityChecks,
  type ErasureEligibilityChecks,
} from '../services/erasureGuards.js'
import { generateOtpSalt, hashOtp } from '../utils/otp.js'
import * as auditLogger from '../utils/auditLogger.js'
import * as dbModule from '../db.js'

const OTP = '123456'

function buildApp(checks: ErasureEligibilityChecks): express.Express {
  const app = express()
  app.use(requestIdMiddleware)
  app.use(express.json())
  app.use('/api/v1/user/erasure', createUserErasureRouter({ eligibilityChecks: checks }))
  app.use('/api/v1/admin/erasure', createAdminErasureRouter({ eligibilityChecks: checks }))
  app.use(errorHandler)
  return app
}

async function issueOtp(email: string, otp = OTP): Promise<void> {
  const salt = generateOtpSalt()
  await otpChallengeStore.set({
    email,
    otpHash: hashOtp(otp, salt),
    salt,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    attempts: 0,
  })
}

describe('Account erasure routes', () => {
  let app: express.Express
  let checks: { activeDeals: number; balanceNgn: number }
  let auditSpy: ReturnType<typeof vi.spyOn>
  let userId: string
  let userEmail: string
  let userToken: string
  let adminToken: string
  let adminId: string
  let tenantToken: string

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

  async function requestErasure(token = userToken, email = userEmail) {
    await issueOtp(email)
    return request(app).post('/api/v1/user/erasure').set(auth(token)).send({ otp: OTP })
  }

  function auditEvents(): string[] {
    return auditSpy.mock.calls.map((call: unknown[]) => call[0] as string)
  }

  beforeEach(async () => {
    vi.restoreAllMocks()
    initErasureRequestStore(new InMemoryErasureRequestStore())
    sessionStore.clear()
    userStore.clear()
    otpChallengeStore.clear()
    await dealStore.clear()

    checks = { activeDeals: 0, balanceNgn: 0 }
    app = buildApp({
      countActiveDeals: async () => checks.activeDeals,
      getWalletBalanceNgn: async () => checks.balanceNgn,
    })
    auditSpy = vi.spyOn(auditLogger, 'auditLog')

    const user = await userStore.getOrCreateByEmail('erasure-user@example.com')
    userId = user.id
    userEmail = user.email
    userToken = 'test-token-erasure-user'
    await sessionStore.create(user.email, userToken)

    const admin = await userStore.getOrCreateByEmail('erasure-admin@example.com')
    admin.role = 'admin'
    adminId = admin.id
    adminToken = 'test-token-erasure-admin'
    await sessionStore.create(admin.email, adminToken)

    const tenant = await userStore.getOrCreateByEmail('erasure-other@example.com')
    tenantToken = 'test-token-erasure-other'
    await sessionStore.create(tenant.email, tenantToken)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('POST /api/v1/user/erasure', () => {
    it('requires authentication', async () => {
      const res = await request(app).post('/api/v1/user/erasure').send({ otp: OTP })
      expect(res.status).toBe(401)
    })

    it('creates a pending request with confirm_by ~30 days out and audits it', async () => {
      const res = await requestErasure()

      expect(res.status).toBe(201)
      expect(res.body.data).toMatchObject({ userId, status: 'pending', confirmedAt: null })
      const confirmBy = new Date(res.body.data.confirmBy).getTime()
      expect(confirmBy - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000)
      expect(auditEvents()).toContain('USER_ERASURE_REQUESTED')
    })

    it('rejects a wrong OTP with 403 and creates nothing', async () => {
      await issueOtp(userEmail)
      const res = await request(app)
        .post('/api/v1/user/erasure')
        .set(auth(userToken))
        .send({ otp: '000000' })

      expect(res.status).toBe(403)
      expect(await erasureRequestStore.findLatestByUserId(userId)).toBeNull()
      expect(auditEvents()).not.toContain('USER_ERASURE_REQUESTED')
    })

    it('rejects when no fresh OTP was requested', async () => {
      const res = await request(app)
        .post('/api/v1/user/erasure')
        .set(auth(userToken))
        .send({ otp: OTP })
      expect(res.status).toBe(403)
    })

    it('consumes the OTP so it cannot be replayed', async () => {
      await requestErasure()
      await request(app).delete('/api/v1/user/erasure').set(auth(userToken))

      const replay = await request(app)
        .post('/api/v1/user/erasure')
        .set(auth(userToken))
        .send({ otp: OTP })
      expect(replay.status).toBe(403)
    })

    it('rejects wallet-signature re-auth for an account without a linked wallet', async () => {
      const res = await request(app)
        .post('/api/v1/user/erasure')
        .set(auth(userToken))
        .send({ signedChallengeXdr: 'AAAA' })
      expect(res.status).toBe(403)
    })

    it('requires exactly one re-auth proof', async () => {
      const none = await request(app).post('/api/v1/user/erasure').set(auth(userToken)).send({})
      expect(none.status).toBe(400)

      const both = await request(app)
        .post('/api/v1/user/erasure')
        .set(auth(userToken))
        .send({ otp: OTP, signedChallengeXdr: 'AAAA' })
      expect(both.status).toBe(400)
    })

    it('returns 409 when a request is already pending', async () => {
      expect((await requestErasure()).status).toBe(201)

      const res = await requestErasure()
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('CONFLICT')
    })

    it('blocks erasure while the user has an active deal', async () => {
      checks.activeDeals = 2
      const res = await requestErasure()

      expect(res.status).toBe(409)
      expect(res.body.error.message).toMatch(/active deal/)
      expect(res.body.error.details.blockers).toEqual([
        expect.objectContaining({ type: 'active_deal', count: 2 }),
      ])
      expect(await erasureRequestStore.findLatestByUserId(userId)).toBeNull()
    })

    it('blocks erasure while the wallet balance is non-zero', async () => {
      checks.balanceNgn = 1500
      const res = await requestErasure()

      expect(res.status).toBe(409)
      expect(res.body.error.message).toMatch(/wallet balance/)
      expect(res.body.error.details.blockers).toEqual([
        expect.objectContaining({ type: 'wallet_balance', balanceNgn: 1500 }),
      ])
    })

    it('blocks erasure for a negative (owed) wallet balance too', async () => {
      checks.balanceNgn = -200
      expect((await requestErasure()).status).toBe(409)
    })
  })

  describe('GET /api/v1/user/erasure', () => {
    it('returns null when the user never requested erasure', async () => {
      const res = await request(app).get('/api/v1/user/erasure').set(auth(userToken))
      expect(res.status).toBe(200)
      expect(res.body.data).toBeNull()
    })

    it('returns the current request status and confirm_by', async () => {
      const created = await requestErasure()
      const res = await request(app).get('/api/v1/user/erasure').set(auth(userToken))

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({
        id: created.body.data.id,
        status: 'pending',
        confirmBy: created.body.data.confirmBy,
      })
    })
  })

  describe('lifecycle', () => {
    it('request -> cancel', async () => {
      const created = await requestErasure()

      const cancel = await request(app).delete('/api/v1/user/erasure').set(auth(userToken))
      expect(cancel.status).toBe(200)
      expect(cancel.body.data).toMatchObject({ id: created.body.data.id, status: 'cancelled' })
      expect(auditEvents()).toContain('USER_ERASURE_CANCELLED')

      const status = await request(app).get('/api/v1/user/erasure').set(auth(userToken))
      expect(status.body.data.status).toBe('cancelled')

      // Cancelling again: nothing pending
      const again = await request(app).delete('/api/v1/user/erasure').set(auth(userToken))
      expect(again.status).toBe(404)

      // A fresh request is allowed after cancelling
      expect((await requestErasure()).status).toBe(201)
    })

    it('request -> admin confirm', async () => {
      const created = await requestErasure()
      const id = created.body.data.id

      const list = await request(app)
        .get('/api/v1/admin/erasure?status=pending')
        .set(auth(adminToken))
      expect(list.status).toBe(200)
      expect(list.body.total).toBe(1)
      expect(list.body.data[0]).toMatchObject({ id, status: 'pending' })

      const confirm = await request(app)
        .post(`/api/v1/admin/erasure/${id}/confirm`)
        .set(auth(adminToken))
      expect(confirm.status).toBe(200)
      expect(confirm.body.data).toMatchObject({ id, status: 'completed', confirmedBy: adminId })
      expect(auditEvents()).toContain('USER_ERASURE_COMPLETED')

      const completed = await request(app)
        .get('/api/v1/admin/erasure?status=completed')
        .set(auth(adminToken))
      expect(completed.body.data.map((r: { id: string }) => r.id)).toEqual([id])

      // Cannot confirm twice / cancel a completed request
      const twice = await request(app)
        .post(`/api/v1/admin/erasure/${id}/confirm`)
        .set(auth(adminToken))
      expect(twice.status).toBe(409)
      const cancel = await request(app).delete('/api/v1/user/erasure').set(auth(userToken))
      expect(cancel.status).toBe(404)
    })

    it('request -> expire via expireOverdueRequests', async () => {
      const created = await requestErasure()
      const id = created.body.data.id

      const expired = await erasureRequestStore.expireOverdueRequests(
        new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
      )
      expect(expired).toBe(1)
      expect(auditSpy).toHaveBeenCalledWith(
        'USER_ERASURE_EXPIRED',
        expect.objectContaining({ actorType: 'system', userId }),
        { erasureRequestId: id },
      )

      const status = await request(app).get('/api/v1/user/erasure').set(auth(userToken))
      expect(status.body.data).toMatchObject({ id, status: 'expired' })

      const confirm = await request(app)
        .post(`/api/v1/admin/erasure/${id}/confirm`)
        .set(auth(adminToken))
      expect(confirm.status).toBe(409)

      const cancel = await request(app).delete('/api/v1/user/erasure').set(auth(userToken))
      expect(cancel.status).toBe(404)
    })
  })

  describe('admin endpoints', () => {
    it('return 403 for users without the erasure:manage permission', async () => {
      const created = await requestErasure()

      const list = await request(app).get('/api/v1/admin/erasure').set(auth(tenantToken))
      expect(list.status).toBe(403)

      const confirm = await request(app)
        .post(`/api/v1/admin/erasure/${created.body.data.id}/confirm`)
        .set(auth(tenantToken))
      expect(confirm.status).toBe(403)

      const status = await request(app).get('/api/v1/user/erasure').set(auth(userToken))
      expect(status.body.data.status).toBe('pending')
    })

    it('enforce the erasure:manage RBAC permission (403 for other admin roles)', async () => {
      const created = await requestErasure()
      const id = created.body.data.id

      let grants: Array<{ role_name: string; resource: string | null; action: string | null }> = [
        { role_name: 'support', resource: 'disputes', action: 'view' },
      ]
      const pool = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM user_roles')) return { rows: grants }
          // Everything else (sessions, audit persistence) falls back to in-memory caches.
          throw new Error('not available in this test')
        }),
      }
      vi.spyOn(dbModule, 'getPool').mockResolvedValue(pool as never)

      const denied = await request(app)
        .post(`/api/v1/admin/erasure/${id}/confirm`)
        .set(auth(adminToken))
      expect(denied.status).toBe(403)

      grants = [{ role_name: 'operations', resource: 'erasure', action: 'manage' }]
      const allowed = await request(app)
        .post(`/api/v1/admin/erasure/${id}/confirm`)
        .set(auth(adminToken))
      expect(allowed.status).toBe(200)
      expect(allowed.body.data.status).toBe('completed')
    })

    it('re-checks blockers on confirm (deal opened after the request)', async () => {
      const created = await requestErasure()
      checks.activeDeals = 1

      const confirm = await request(app)
        .post(`/api/v1/admin/erasure/${created.body.data.id}/confirm`)
        .set(auth(adminToken))
      expect(confirm.status).toBe(409)
      expect(confirm.body.error.details.blockers[0].type).toBe('active_deal')
      expect(auditEvents()).not.toContain('USER_ERASURE_COMPLETED')

      const status = await request(app).get('/api/v1/user/erasure').set(auth(userToken))
      expect(status.body.data.status).toBe('pending')
    })

    it('re-checks wallet balance on confirm', async () => {
      const created = await requestErasure()
      checks.balanceNgn = 10

      const confirm = await request(app)
        .post(`/api/v1/admin/erasure/${created.body.data.id}/confirm`)
        .set(auth(adminToken))
      expect(confirm.status).toBe(409)
      expect(confirm.body.error.details.blockers[0].type).toBe('wallet_balance')
    })

    it('returns 404 for an unknown request and 400 for a malformed id', async () => {
      const unknown = await request(app)
        .post('/api/v1/admin/erasure/00000000-0000-4000-8000-000000000000/confirm')
        .set(auth(adminToken))
      expect(unknown.status).toBe(404)

      const malformed = await request(app)
        .post('/api/v1/admin/erasure/not-a-uuid/confirm')
        .set(auth(adminToken))
      expect(malformed.status).toBe(400)
    })

    it('rejects an invalid status filter', async () => {
      const res = await request(app)
        .get('/api/v1/admin/erasure?status=bogus')
        .set(auth(adminToken))
      expect(res.status).toBe(400)
    })
  })

  describe('default eligibility checks', () => {
    it('count active and at-risk deals as tenant or landlord, ignoring completed ones', async () => {
      const defaults = createDefaultErasureEligibilityChecks()
      const deal = await dealStore.create({
        tenantId: userId,
        landlordId: 'landlord-x',
        annualRentNgn: 1_200_000,
        depositNgn: 240_000,
        termMonths: 12,
      })

      await dealStore.updateStatus(deal.dealId, DealStatus.ACTIVE)
      expect(await defaults.countActiveDeals(userId)).toBe(1)
      expect(await defaults.countActiveDeals('landlord-x')).toBe(1)

      await dealStore.updateStatus(deal.dealId, DealStatus.COMPLETED)
      expect(await defaults.countActiveDeals(userId)).toBe(0)
    })

    it('treat a user without an NGN wallet as zero balance (no wallet is created)', async () => {
      const getBalance = vi.fn()
      const defaults = createDefaultErasureEligibilityChecks({ getBalance })
      expect(await defaults.getWalletBalanceNgn('user-without-wallet')).toBe(0)
      expect(getBalance).not.toHaveBeenCalled()
    })
  })
})
