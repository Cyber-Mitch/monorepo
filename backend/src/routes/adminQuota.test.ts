import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { createAdminQuotaRouter } from './adminQuota.js'
import { quotaManager } from '../services/QuotaManager.js'
import { burstRateLimiter } from '../services/BurstRateLimiter.js'

vi.mock('../services/QuotaManager.js', () => ({
  quotaManager: {
    getQuotaUsage: vi.fn(),
    getUserOverrides: vi.fn(),
    setOverride: vi.fn(),
    removeOverride: vi.fn(),
    getQuotaStats: vi.fn(),
  },
}))

vi.mock('../services/BurstRateLimiter.js', () => ({
  burstRateLimiter: {
    resetQuota: vi.fn(),
  },
}))

vi.mock('../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (_req: any, _res: any, next: any) => next(),
  type: {},
}))

vi.mock('../db.js', () => ({
  getPool: vi.fn(async () => null),
  setPool: vi.fn(),
  getPoolMetrics: vi.fn(() => null),
}))

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => {
    req.requestId = 'test-request-id'
    next()
  })
  app.use('/api/admin/quota', createAdminQuotaRouter())
  app.use(errorHandler)
  return app
}

describe('Admin Quota Routes', () => {
  describe('GET /api/admin/quota/usage/:userId', () => {
    it('should get quota usage for a user as admin', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      vi.mocked(quotaManager.getQuotaUsage).mockResolvedValue({
        userId: 'user-456',
        endpoint: 'all',
        minuteUsage: 15,
        dayUsage: 200,
        minuteLimit: 100,
        dayLimit: 1000,
        minuteReset: Date.now() + 60000,
        dayReset: Date.now() + 86400000,
        nearLimit: false,
      })

      const res = await request(app).get('/api/admin/quota/usage/user-456')

      expect(res.status).toBe(200)
      expect(res.body.userId).toBe('user-456')
      expect(res.body.minuteUsage).toBe(15)
      expect(res.body.dayUsage).toBe(200)
    })

    it('should reject request from non-admin user', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'tenant-123', role: 'tenant' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      const res = await request(app).get('/api/admin/quota/usage/user-456')

      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
      expect(res.body.error.message).toBe('Forbidden')
    })

    it('should allow user with admin role', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      vi.mocked(quotaManager.getQuotaUsage).mockResolvedValue({
        userId: 'user-789',
        endpoint: 'all',
        minuteUsage: 5,
        dayUsage: 50,
        minuteLimit: 100,
        dayLimit: 1000,
        minuteReset: Date.now() + 60000,
        dayReset: Date.now() + 86400000,
        nearLimit: false,
      })

      const res = await request(app).get('/api/admin/quota/usage/user-789')

      expect(res.status).toBe(200)
    })

    it('should support endpoint query parameter', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      vi.mocked(quotaManager.getQuotaUsage).mockResolvedValue({
        userId: 'user-999',
        endpoint: '/api/deals',
        minuteUsage: 25,
        dayUsage: 300,
        minuteLimit: 100,
        dayLimit: 1000,
        minuteReset: Date.now() + 60000,
        dayReset: Date.now() + 86400000,
        nearLimit: true,
      })

      const res = await request(app).get('/api/admin/quota/usage/user-999?endpoint=/api/deals')

      expect(res.status).toBe(200)
      expect(vi.mocked(quotaManager.getQuotaUsage)).toHaveBeenCalledWith('user-999', '/api/deals')
    })
  })

  describe('GET /api/admin/quota/overrides/:userId', () => {
    it('should get quota overrides for a user as admin', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      vi.mocked(quotaManager.getUserOverrides).mockResolvedValue([
        {
          userId: 'user-456',
          endpoint: '/api/payments',
          elevatedLimit: 500,
          reason: 'Business need',
          createdBy: 'admin-123',
          createdAt: Date.now(),
        },
      ])

      const res = await request(app).get('/api/admin/quota/overrides/user-456')

      expect(res.status).toBe(200)
      expect(res.body.overrides).toBeInstanceOf(Array)
      expect(res.body.overrides[0].userId).toBe('user-456')
      expect(res.body.overrides[0].elevatedLimit).toBe(500)
    })

    it('should reject request from non-admin user', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'tenant-123', role: 'tenant' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      const res = await request(app).get('/api/admin/quota/overrides/user-456')

      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    })

    it('should return empty array when no overrides exist', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      vi.mocked(quotaManager.getUserOverrides).mockResolvedValue([])

      const res = await request(app).get('/api/admin/quota/overrides/user-789')

      expect(res.status).toBe(200)
      expect(res.body.overrides).toEqual([])
    })
  })

  describe('POST /api/admin/quota/override', () => {
    it('should create a quota override as admin', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      const overrideData = {
        userId: 'user-456',
        endpoint: '/api/deals',
        elevatedLimit: 200,
        reason: 'Increased business activity',
      }

      vi.mocked(quotaManager.setOverride).mockResolvedValue()

      const res = await request(app).post('/api/admin/quota/override').send(overrideData)

      expect(res.status).toBe(201)
      expect(res.body.success).toBe(true)
      expect(vi.mocked(quotaManager.setOverride)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-456',
          endpoint: '/api/deals',
          elevatedLimit: 200,
          reason: 'Increased business activity',
          createdBy: 'admin-123',
        })
      )
    })

    it('should validate required fields', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      const res = await request(app)
        .post('/api/admin/quota/override')
        .send({ elevatedLimit: 200 }) // Missing userId and reason

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('should validate elevatedLimit range', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      const res = await request(app)
        .post('/api/admin/quota/override')
        .send({
          userId: 'user-456',
          elevatedLimit: 15000, // Invalid: > 10000
          reason: 'Test',
        })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('should validate reason length', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      const res = await request(app)
        .post('/api/admin/quota/override')
        .send({
          userId: 'user-456',
          elevatedLimit: 200,
          reason: 'a'.repeat(600), // Invalid: > 500 chars
        })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('should reject request from non-admin user', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'tenant-123', role: 'tenant' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      const res = await request(app)
        .post('/api/admin/quota/override')
        .send({
          userId: 'user-456',
          elevatedLimit: 200,
          reason: 'Test',
        })

      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    })

    it('should allow optional expiresAt field', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      vi.mocked(quotaManager.setOverride).mockResolvedValue()

      const res = await request(app)
        .post('/api/admin/quota/override')
        .send({
          userId: 'user-456',
          elevatedLimit: 200,
          reason: 'Test',
          expiresAt: Date.now() + 86400000,
        })

      expect(res.status).toBe(201)
    })
  })

  describe('DELETE /api/admin/quota/override', () => {
    it('should remove a quota override as admin', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      vi.mocked(quotaManager.removeOverride).mockResolvedValue()

      const res = await request(app)
        .delete('/api/admin/quota/override')
        .send({
          userId: 'user-456',
          endpoint: '/api/payments',
        })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(vi.mocked(quotaManager.removeOverride)).toHaveBeenCalledWith('user-456', '/api/payments')
    })

    it('should validate required fields', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      const res = await request(app).delete('/api/admin/quota/override').send({})

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('should reject request from non-admin user', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'tenant-123', role: 'tenant' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      const res = await request(app)
        .delete('/api/admin/quota/override')
        .send({ userId: 'user-456' })

      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    })

    it('should allow removal without endpoint (all endpoints)', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      vi.mocked(quotaManager.removeOverride).mockResolvedValue()

      const res = await request(app)
        .delete('/api/admin/quota/override')
        .send({ userId: 'user-456' })

      expect(res.status).toBe(200)
      expect(vi.mocked(quotaManager.removeOverride)).toHaveBeenCalledWith('user-456', undefined)
    })
  })

  describe('GET /api/admin/quota/stats', () => {
    it('should get quota statistics as admin', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      vi.mocked(quotaManager.getQuotaStats).mockResolvedValue({
        totalOverrides: 15,
        activeOverrides: 10,
        nearLimitUsers: 3,
      })

      const res = await request(app).get('/api/admin/quota/stats')

      expect(res.status).toBe(200)
      expect(res.body.totalOverrides).toBe(15)
      expect(res.body.activeOverrides).toBe(10)
      expect(res.body.nearLimitUsers).toBe(3)
    })

    it('should reject request from non-admin user', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'tenant-123', role: 'tenant' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      const res = await request(app).get('/api/admin/quota/stats')

      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    })
  })

  describe('POST /api/admin/quota/reset', () => {
    it('should reset quota for a user as admin', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      vi.mocked(burstRateLimiter.resetQuota).mockResolvedValue()

      const res = await request(app)
        .post('/api/admin/quota/reset')
        .send({ userId: 'user-456', endpoint: '/api/deals' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(vi.mocked(burstRateLimiter.resetQuota)).toHaveBeenCalledWith('ratelimit:user:user-456:/api/deals')
    })

    it('should validate required userId field', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      const res = await request(app)
        .post('/api/admin/quota/reset')
        .send({ endpoint: '/api/deals' })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('should allow reset without endpoint (all endpoints)', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'admin-123', role: 'admin' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      vi.mocked(burstRateLimiter.resetQuota).mockResolvedValue()

      const res = await request(app)
        .post('/api/admin/quota/reset')
        .send({ userId: 'user-456' })

      expect(res.status).toBe(200)
      expect(vi.mocked(burstRateLimiter.resetQuota)).toHaveBeenCalledWith('ratelimit:user:user-456')
    })

    it('should reject request from non-admin user', async () => {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res: any, next: any) => {
        req.requestId = 'test-request-id'
        req.user = { id: 'tenant-123', role: 'tenant' }
        next()
      })
      app.use('/api/admin/quota', createAdminQuotaRouter())
      app.use(errorHandler)

      const res = await request(app)
        .post('/api/admin/quota/reset')
        .send({ userId: 'user-456' })

      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    })
  })
})
