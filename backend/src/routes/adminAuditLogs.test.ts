import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { createAdminAuditLogsRouter } from './adminAuditLogs.js'
import { auditLogRepository } from '../repositories/AuditLogRepository.js'
import { auditLog } from '../utils/auditLogger.js'

vi.mock('../repositories/AuditLogRepository.js', () => ({
  auditLogRepository: {
    list: vi.fn(),
  },
}))

vi.mock('../middleware/auth.js', async () => {
  const { AppError } = await import('../errors/AppError.js')
  const { ErrorCode } = await import('../errors/errorCodes.js')
  return {
    authenticateToken: (req: any, _res: any, next: any) => {
      if (req.headers.authorization === 'Bearer admin-token') {
        req.user = { id: 'admin-1', role: 'admin' }
        next()
        return
      }
      if (req.headers.authorization === 'Bearer tenant-token') {
        req.user = { id: 'tenant-1', role: 'tenant' }
        next()
        return
      }
      next(new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication token required'))
    },
  }
})

// requirePermission falls back to the legacy role when there is no database, so the
// permission check runs for real without one.
vi.mock('../db.js', () => ({
  getPool: vi.fn(async () => null),
  setPool: vi.fn(),
  getPoolMetrics: vi.fn(() => null),
}))

vi.mock('../utils/auditLogger.js', () => ({
  auditLog: vi.fn(),
  extractAuditContext: vi.fn(() => ({})),
}))

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => {
    req.requestId = 'test-request-id'
    next()
  })
  app.use('/api/v1/admin/audit-logs', createAdminAuditLogsRouter())
  app.use(errorHandler)
  return app
}

describe('Admin Audit Logs Routes', () => {
  describe('GET /api/v1/admin/audit-logs', () => {
    it('should list audit logs for an admin with audit:view', async () => {
      vi.mocked(auditLogRepository.list).mockResolvedValue({
        entries: [
          {
            id: 'log-1',
            action: 'USER_LOGIN',
            actorId: 'user-123',
            actorType: 'user',
            resourceType: 'user',
            resourceId: 'user-123',
            ipAddress: '192.168.1.1',
            result: 'success',
            metadata: {},
            createdAt: new Date('2024-01-01T00:00:00Z'),
          },
        ],
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1,
      })

      const res = await request(buildApp())
        .get('/api/v1/admin/audit-logs')
        .set('Authorization', 'Bearer admin-token')

      expect(res.status).toBe(200)
      expect(res.body.entries).toBeInstanceOf(Array)
      expect(res.body.entries.length).toBeGreaterThan(0)
      expect(res.body.entries[0]).toMatchObject({
        id: 'log-1',
        action: 'USER_LOGIN',
        actorId: 'user-123',
        result: 'success',
      })
      expect(res.body.pagination).toMatchObject({
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1,
      })
    })

    it('should filter by actorId', async () => {
      vi.mocked(auditLogRepository.list).mockResolvedValue({
        entries: [
          {
            id: 'log-2',
            action: 'DEAL_CREATED',
            actorId: 'user-456',
            actorType: 'user',
            resourceType: 'deal',
            resourceId: 'deal-123',
            ipAddress: null,
            result: 'success',
            metadata: {},
            createdAt: new Date('2024-01-02T00:00:00Z'),
          },
        ],
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1,
      })

      const res = await request(buildApp())
        .get('/api/v1/admin/audit-logs?actorId=user-456')
        .set('Authorization', 'Bearer admin-token')

      expect(res.status).toBe(200)
      expect(vi.mocked(auditLogRepository.list)).toHaveBeenCalledWith(
        { actorId: 'user-456' },
        { page: 1, limit: 50 }
      )
    })

    it('should filter by action', async () => {
      vi.mocked(auditLogRepository.list).mockResolvedValue({
        entries: [],
        total: 0,
        page: 1,
        limit: 50,
        totalPages: 0,
      })

      const res = await request(buildApp())
        .get('/api/v1/admin/audit-logs?action=USER_LOGIN')
        .set('Authorization', 'Bearer admin-token')

      expect(res.status).toBe(200)
      expect(vi.mocked(auditLogRepository.list)).toHaveBeenCalledWith(
        { action: 'USER_LOGIN' },
        { page: 1, limit: 50 }
      )
    })

    it('should filter by resourceType and resourceId', async () => {
      vi.mocked(auditLogRepository.list).mockResolvedValue({
        entries: [],
        total: 0,
        page: 1,
        limit: 50,
        totalPages: 0,
      })

      const res = await request(buildApp())
        .get('/api/v1/admin/audit-logs?resourceType=deal&resourceId=deal-123')
        .set('Authorization', 'Bearer admin-token')

      expect(res.status).toBe(200)
      expect(vi.mocked(auditLogRepository.list)).toHaveBeenCalledWith(
        { resourceType: 'deal', resourceId: 'deal-123' },
        { page: 1, limit: 50 }
      )
    })

    it('should filter by date range', async () => {
      vi.mocked(auditLogRepository.list).mockResolvedValue({
        entries: [],
        total: 0,
        page: 1,
        limit: 50,
        totalPages: 0,
      })

      const startDate = '2024-01-01T00:00:00Z'
      const endDate = '2024-01-31T23:59:59Z'

      const res = await request(buildApp())
        .get(`/api/v1/admin/audit-logs?startDate=${startDate}&endDate=${endDate}`)
        .set('Authorization', 'Bearer admin-token')

      expect(res.status).toBe(200)
      expect(vi.mocked(auditLogRepository.list)).toHaveBeenCalledWith(
        {
          startDate: new Date(startDate),
          endDate: new Date(endDate),
        },
        { page: 1, limit: 50 }
      )
    })

    it('should support pagination', async () => {
      vi.mocked(auditLogRepository.list).mockResolvedValue({
        entries: [],
        total: 100,
        page: 2,
        limit: 25,
        totalPages: 4,
      })

      const res = await request(buildApp())
        .get('/api/v1/admin/audit-logs?page=2&limit=25')
        .set('Authorization', 'Bearer admin-token')

      expect(res.status).toBe(200)
      expect(vi.mocked(auditLogRepository.list)).toHaveBeenCalledWith(
        {},
        { page: 2, limit: 25 }
      )
      expect(res.body.pagination).toMatchObject({
        total: 100,
        page: 2,
        limit: 25,
        totalPages: 4,
      })
    })

    it('should validate limit parameter (max 200)', async () => {
      const res = await request(buildApp())
        .get('/api/v1/admin/audit-logs?limit=300')
        .set('Authorization', 'Bearer admin-token')

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('should validate page parameter (must be positive)', async () => {
      const res = await request(buildApp())
        .get('/api/v1/admin/audit-logs?page=0')
        .set('Authorization', 'Bearer admin-token')

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('should validate startDate format', async () => {
      const res = await request(buildApp())
        .get('/api/v1/admin/audit-logs?startDate=invalid-date')
        .set('Authorization', 'Bearer admin-token')

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('should reject request without a bearer token', async () => {
      vi.mocked(auditLogRepository.list).mockResolvedValue({
        entries: [],
        total: 0,
        page: 1,
        limit: 50,
        totalPages: 0,
      })

      const res = await request(buildApp()).get('/api/v1/admin/audit-logs')

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHORIZED')
    })

    it('should reject a signed-in user without audit:view', async () => {
      vi.mocked(auditLogRepository.list).mockResolvedValue({
        entries: [],
        total: 0,
        page: 1,
        limit: 50,
        totalPages: 0,
      })

      const res = await request(buildApp())
        .get('/api/v1/admin/audit-logs')
        .set('Authorization', 'Bearer tenant-token')

      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    })

    it('should record who searched the audit log', async () => {
      vi.mocked(auditLogRepository.list).mockResolvedValue({
        entries: [],
        total: 0,
        page: 1,
        limit: 50,
        totalPages: 0,
      })

      const res = await request(buildApp())
        .get('/api/v1/admin/audit-logs?actorId=user-123')
        .set('Authorization', 'Bearer admin-token')

      expect(res.status).toBe(200)
      expect(auditLog).toHaveBeenCalledWith(
        'ADMIN_AUDIT_LOG_VIEWED',
        expect.anything(),
        expect.objectContaining({ filters: expect.objectContaining({ actorId: 'user-123' }) }),
      )
    })

    it('should return empty results when no logs match filters', async () => {
      vi.mocked(auditLogRepository.list).mockResolvedValue({
        entries: [],
        total: 0,
        page: 1,
        limit: 50,
        totalPages: 0,
      })

      const res = await request(buildApp())
        .get('/api/v1/admin/audit-logs?action=NONEXISTENT_ACTION')
        .set('Authorization', 'Bearer admin-token')

      expect(res.status).toBe(200)
      expect(res.body.entries).toEqual([])
      expect(res.body.pagination.total).toBe(0)
    })

    it('should include all entry fields in response', async () => {
      vi.mocked(auditLogRepository.list).mockResolvedValue({
        entries: [
          {
            id: 'log-3',
            action: 'PAYMENT_APPROVED',
            actorId: 'admin-1',
            actorType: 'admin',
            resourceType: 'payment',
            resourceId: 'payment-123',
            ipAddress: '10.0.0.1',
            result: 'success',
            metadata: { amount: 5000 },
            createdAt: new Date('2024-01-03T00:00:00Z'),
          },
        ],
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1,
      })

      const res = await request(buildApp())
        .get('/api/v1/admin/audit-logs')
        .set('Authorization', 'Bearer admin-token')

      expect(res.status).toBe(200)
      expect(res.body.entries[0]).toMatchObject({
        id: 'log-3',
        action: 'PAYMENT_APPROVED',
        actorId: 'admin-1',
        actorType: 'admin',
        resourceType: 'payment',
        resourceId: 'payment-123',
        ipAddress: '10.0.0.1',
        result: 'success',
        metadata: { amount: 5000 },
        createdAt: '2024-01-03T00:00:00.000Z',
      })
    })
  })
})
