import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { createAdminRiskRouter } from './adminRisk.js'
import { NgnWalletService } from '../services/ngnWalletService.js'
import { userRiskStateStore } from '../models/userRiskStateStore.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { logger } from '../utils/logger.js'

describe('Admin Risk Routes', () => {
  let app: Express
  let ngnWalletService: NgnWalletService
  let authToken: string
  const testUserId = 'test-user-789'
  const adminUserId = 'admin-user-123'

  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeEach(async () => {
    ngnWalletService = new NgnWalletService()
    userRiskStateStore.clear()

    // Setup test admin user
    userStore.clear()
    sessionStore.clear()

    const adminUser = await userStore.getOrCreateByEmail('admin@test.com')
    adminUser.role = 'admin' // no RBAC database in tests: requirePermission falls back to the legacy role
    const testToken = `test-token-${Date.now()}-${Math.random().toString(36).substring(7)}`
    const session = await sessionStore.create('admin@test.com', testToken)
    authToken = session.token

    // Setup Express app
    app = express()
    app.use(express.json())
    app.use((req: any, _res, next) => {
      req.requestId = req.header('x-request-id') ?? 'test-request-id'
      next()
    })
    app.use('/api/admin/risk', createAdminRiskRouter(ngnWalletService))
    app.use(errorHandler)
  })

  describe('GET /api/admin/risk/frozen-users', () => {
    it('should return empty list when no users are frozen', async () => {
      const response = await request(app)
        .get('/api/admin/risk/frozen-users')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.users).toEqual([])
    })

    it('should return list of frozen users', async () => {
      await userRiskStateStore.freeze(testUserId, 'NEGATIVE_BALANCE', 'Test freeze')
      await userRiskStateStore.freeze('another-user', 'MANUAL', 'Admin freeze')

      const response = await request(app)
        .get('/api/admin/risk/frozen-users')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.users).toHaveLength(2)
      expect(response.body.users[0].isFrozen).toBe(true)
    })

    it('should require authentication', async () => {
      await request(app).get('/api/admin/risk/frozen-users').expect(401)
    })
  })

  describe('GET /api/admin/risk/:userId', () => {
    it('should return risk state and balances for user', async () => {
      await userRiskStateStore.freeze(testUserId, 'NEGATIVE_BALANCE', 'Test freeze')

      const response = await request(app)
        .get(`/api/admin/risk/${testUserId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.riskState.userId).toBe(testUserId)
      expect(response.body.riskState.isFrozen).toBe(true)
      expect(response.body.riskState.freezeReason).toBe('NEGATIVE_BALANCE')
      expect(response.body.balances).toBeDefined()
      expect(response.body.balances.totalNgn).toBeDefined()
    })

    it('should return default unfrozen state for user with no risk record', async () => {
      const response = await request(app)
        .get(`/api/admin/risk/${testUserId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.riskState.userId).toBe(testUserId)
      expect(response.body.riskState.isFrozen).toBe(false)
      expect(response.body.riskState.freezeReason).toBeNull()
    })
  })

  describe('POST /api/admin/risk/:userId/freeze', () => {
    it('should freeze user account with MANUAL reason', async () => {
      const response = await request(app)
        .post(`/api/admin/risk/${testUserId}/freeze`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          reason: 'MANUAL',
          notes: 'Suspicious activity detected',
        })
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.riskState.isFrozen).toBe(true)
      expect(response.body.riskState.freezeReason).toBe('MANUAL')

      // Verify in store
      const riskState = await userRiskStateStore.getByUserId(testUserId)
      expect(riskState?.isFrozen).toBe(true)
      expect(riskState?.freezeReason).toBe('MANUAL')
    })

    it('should freeze user account with COMPLIANCE reason', async () => {
      const response = await request(app)
        .post(`/api/admin/risk/${testUserId}/freeze`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          reason: 'COMPLIANCE',
          notes: 'KYC verification required',
        })
        .expect(200)

      expect(response.body.riskState.freezeReason).toBe('COMPLIANCE')
    })

    it('should reject invalid freeze reason', async () => {
      await request(app)
        .post(`/api/admin/risk/${testUserId}/freeze`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          reason: 'INVALID_REASON',
          notes: 'Test',
        })
        .expect(400)
    })

    it('logs the incoming correlation id for validation failures on sensitive routes', async () => {
      const warnSpy = vi.spyOn(logger, 'warn')

      await request(app)
        .post(`/api/admin/risk/${testUserId}/freeze`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('x-request-id', 'trace-sensitive-123')
        .send({
          reason: 'INVALID_REASON',
          notes: 'Test',
        })
        .expect(400)

      expect(warnSpy).toHaveBeenCalledWith(
        'Request validation failed',
        expect.objectContaining({
          requestId: 'trace-sensitive-123',
          endpoint: `POST /${testUserId}/freeze`,
          method: 'POST',
          path: `/${testUserId}/freeze`,
          target: 'body',
        }),
      )
    })

    it('should require authentication', async () => {
      await request(app)
        .post(`/api/admin/risk/${testUserId}/freeze`)
        .send({
          reason: 'MANUAL',
        })
        .expect(401)
    })
  })

  describe('POST /api/admin/risk/:userId/unfreeze', () => {
    it('should unfreeze user account', async () => {
      await userRiskStateStore.freeze(testUserId, 'MANUAL', 'Test freeze')

      const response = await request(app)
        .post(`/api/admin/risk/${testUserId}/unfreeze`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          notes: 'Issue resolved',
        })
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.riskState.isFrozen).toBe(false)
      expect(response.body.riskState.freezeReason).toBeNull()

      // Verify in store
      const riskState = await userRiskStateStore.getByUserId(testUserId)
      expect(riskState?.isFrozen).toBe(false)
    })

    it('should throw error when trying to unfreeze non-existent risk state', async () => {
      await request(app)
        .post(`/api/admin/risk/${testUserId}/unfreeze`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          notes: 'Test',
        })
        .expect(500)
    })
  })

  describe('authorization (#1933)', () => {
    let tenantToken: string

    beforeEach(async () => {
      await userStore.getOrCreateByEmail('tenant@test.com') // default role: tenant
      tenantToken = (await sessionStore.create('tenant@test.com', `tenant-${Date.now()}`)).token
    })

    const routes: Array<['get' | 'post', string]> = [
      ['get', '/api/admin/risk/frozen-users'],
      ['get', `/api/admin/risk/${'victim-user'}`],
      ['post', '/api/admin/risk/victim-user/freeze'],
      ['post', '/api/admin/risk/victim-user/unfreeze'],
    ]

    it.each(routes)('%s %s rejects a normal logged-in user with 403 and changes nothing', async (method, path) => {
      const res = await request(app)[method](path)
        .set('Authorization', `Bearer ${tenantToken}`)
        .send({ reason: 'MANUAL', notes: 'attack' })

      expect(res.status).toBe(403)
      expect(await userRiskStateStore.getByUserId('victim-user')).toBeFalsy()
    })

    it.each(routes)('%s %s rejects an unauthenticated caller with 401', async (method, path) => {
      await request(app)[method](path).send({}).expect(401)
    })

    it('does not let a normal user unfreeze an account frozen for fraud', async () => {
      await userRiskStateStore.freeze('victim-user', 'COMPLIANCE', 'fraud review')

      await request(app)
        .post('/api/admin/risk/victim-user/unfreeze')
        .set('Authorization', `Bearer ${tenantToken}`)
        .send({ notes: 'me' })
        .expect(403)

      expect((await userRiskStateStore.getByUserId('victim-user'))?.isFrozen).toBe(true)
    })

    it('lets an admin freeze and unfreeze, and records that admin as the actor', async () => {
      const spy = vi.spyOn(logger, 'info')

      await request(app)
        .post('/api/admin/risk/victim-user/freeze')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reason: 'MANUAL', notes: 'review' })
        .expect(200)
      await request(app)
        .post('/api/admin/risk/victim-user/unfreeze')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ notes: 'cleared' })
        .expect(200)

      const adminId = (await userStore.getByEmail('admin@test.com'))!.id
      expect(spy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ adminId }))
    })
  })
})
