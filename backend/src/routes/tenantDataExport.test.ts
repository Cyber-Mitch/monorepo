import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  generatePresignedDownload: vi.fn(),
  auditLog: vi.fn(),
}))

vi.mock('../jobs/scheduler/worker.js', () => ({
  getScheduler: () => ({ schedule: mocks.schedule }),
}))
vi.mock('../services/storageService.js', () => ({
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  generatePresignedDownload: mocks.generatePresignedDownload,
}))

import { createTenantDataExportRouter } from './tenantDataExport.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'
import { sessionStore, userStore } from '../models/authStore.js'
import {
  InMemoryTenantDataExportStore,
  initTenantDataExportStore,
  tenantDataExportStore,
} from '../models/tenantDataExportStore.js'
import * as auditLogger from '../utils/auditLogger.js'

function buildApp(): express.Express {
  const app = express()
  app.use(requestIdMiddleware)
  app.use(express.json())
  app.use('/api/v1/tenant/data-export', createTenantDataExportRouter())
  app.use(errorHandler)
  return app
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

describe('Tenant data export routes (#1899)', () => {
  let app: express.Express
  let tenantId: string
  let tenantToken: string
  let otherToken: string
  let auditSpy: ReturnType<typeof vi.spyOn>

  function auditEvents(): string[] {
    return auditSpy.mock.calls.map((call: unknown[]) => call[0] as string)
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    initTenantDataExportStore(new InMemoryTenantDataExportStore())
    sessionStore.clear()
    userStore.clear()
    mocks.schedule.mockResolvedValue({ id: 'job-1' })
    mocks.generatePresignedDownload.mockResolvedValue({
      downloadUrl: 'https://storage.example/presigned',
      expiresAt: '2026-10-19T10:05:00.000Z',
    })
    auditSpy = vi.spyOn(auditLogger, 'auditLog').mockImplementation(() => undefined)
    app = buildApp()

    const tenant = await userStore.getOrCreateByEmail('export-tenant@example.com')
    tenantId = tenant.id
    tenantToken = 'test-token-export-tenant'
    await sessionStore.create(tenant.email, tenantToken)

    const other = await userStore.getOrCreateByEmail('export-other@example.com')
    otherToken = 'test-token-export-other'
    await sessionStore.create(other.email, otherToken)
  })

  async function requestExport(token = tenantToken) {
    return request(app).post('/api/v1/tenant/data-export').set(auth(token))
  }

  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/tenant/data-export')
    expect(res.status).toBe(401)
  })

  describe('POST /api/v1/tenant/data-export', () => {
    it('accepts the request, enqueues the job and audits it', async () => {
      const res = await requestExport()

      expect(res.status).toBe(202)
      expect(res.body.data).toMatchObject({ status: 'pending' })
      expect(mocks.schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'tenant.data_export',
          handler: 'tenant.data_export',
          payload: { exportId: res.body.data.id },
        }),
      )
      expect(auditEvents()).toContain('TENANT_DATA_EXPORT_REQUESTED')
    })

    it('rejects a second request while one is in progress (409)', async () => {
      await requestExport()
      const res = await requestExport()

      expect(res.status).toBe(409)
      expect(mocks.schedule).toHaveBeenCalledTimes(1)
    })

    it('rate-limits to one request per 24 hours (429)', async () => {
      const first = await requestExport()
      await tenantDataExportStore.update(first.body.data.id, {
        status: 'ready',
        storageKey: 'tenant-data-exports/x/y.zip',
        expiresAt: new Date(Date.now() + 60_000),
      })

      const res = await requestExport()

      expect(res.status).toBe(429)
      expect(res.body.error.message).toMatch(/Next request allowed at/)
    })

    it('marks the request failed and surfaces an error when the job cannot be queued', async () => {
      mocks.schedule.mockRejectedValue(new Error('queue down'))

      const res = await requestExport()

      expect(res.status).toBe(500)
      const latest = await tenantDataExportStore.findLatestByUserId(tenantId)
      expect(latest).toMatchObject({ status: 'failed' })
    })
  })

  describe('GET /api/v1/tenant/data-export/:id', () => {
    it('shows pending status without a download URL', async () => {
      const created = await requestExport()

      const res = await request(app)
        .get(`/api/v1/tenant/data-export/${created.body.data.id}`)
        .set(auth(tenantToken))

      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('pending')
      expect(res.body.data.downloadUrl).toBeUndefined()
      expect(mocks.generatePresignedDownload).not.toHaveBeenCalled()
    })

    it('issues a short-lived download URL once ready, and audits the download', async () => {
      const created = await requestExport()
      await tenantDataExportStore.update(created.body.data.id, {
        status: 'ready',
        storageKey: 'tenant-data-exports/tenant/id.zip',
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })

      const res = await request(app)
        .get(`/api/v1/tenant/data-export/${created.body.data.id}`)
        .set(auth(tenantToken))

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({
        status: 'ready',
        downloadUrl: 'https://storage.example/presigned',
      })
      expect(mocks.generatePresignedDownload).toHaveBeenCalledWith(
        'tenant-data-exports/tenant/id.zip',
        300,
      )
      expect(auditEvents()).toContain('TENANT_DATA_EXPORT_DOWNLOADED')
    })

    it('reports expired archives without a download URL', async () => {
      const created = await requestExport()
      await tenantDataExportStore.update(created.body.data.id, {
        status: 'ready',
        storageKey: 'tenant-data-exports/tenant/id.zip',
        expiresAt: new Date(Date.now() - 1000),
      })

      const res = await request(app)
        .get(`/api/v1/tenant/data-export/${created.body.data.id}`)
        .set(auth(tenantToken))

      expect(res.body.data.status).toBe('expired')
      expect(res.body.data.downloadUrl).toBeUndefined()
      expect(mocks.generatePresignedDownload).not.toHaveBeenCalled()
    })

    it('returns 404 for another user\'s export', async () => {
      const created = await requestExport()

      const res = await request(app)
        .get(`/api/v1/tenant/data-export/${created.body.data.id}`)
        .set(auth(otherToken))

      expect(res.status).toBe(404)
    })

    it('returns 404 for an unknown id', async () => {
      const res = await request(app)
        .get('/api/v1/tenant/data-export/does-not-exist')
        .set(auth(tenantToken))

      expect(res.status).toBe(404)
    })
  })
})
