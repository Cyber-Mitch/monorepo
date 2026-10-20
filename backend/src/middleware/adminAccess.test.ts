import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { requireAdminAccess, FRESH_AUTH_WINDOW_MS } from './adminAccess.js'
import { errorHandler } from './errorHandler.js'
import { requestIdMiddleware } from './requestId.js'
import { adminAuthHeader, seedAdminSession } from '../test-fixtures/adminAuth.js'
import { logger } from '../utils/logger.js'

vi.mock('../schemas/env.js', () => ({ env: { MANUAL_ADMIN_SECRET: 'legacy-secret-value' } }))

function build() {
  const app = express()
  app.use(requestIdMiddleware)
  app.use(express.json())
  app.get('/view', requireAdminAccess('reconciliation', 'view'), (_q, r) => void r.json({ ok: true }))
  app.post('/act', requireAdminAccess('circuit_breaker', 'execute'), (_q, r) => void r.json({ ok: true, txHash: 'abc' }))
  app.post('/drain', requireAdminAccess('circuit_breaker', 'execute', { freshAuth: true }), (_q, r) => void r.json({ ok: true }))
  app.use(errorHandler)
  return app
}

describe('requireAdminAccess (#1937, #1938, #1939)', () => {
  beforeEach(async () => {
    delete process.env.ALLOW_LEGACY_ADMIN_SECRET
    await seedAdminSession()
  })
  afterEach(() => {
    delete process.env.ALLOW_LEGACY_ADMIN_SECRET
    vi.useRealTimers()
  })

  it('rejects a caller with no token (401) and a non-admin user (403)', async () => {
    await seedAdminSession({ email: 'plain-user@example.com', token: 'plain-token', role: 'tenant' })
    await request(build()).get('/view').expect(401)
    await request(build()).get('/view').set('Authorization', 'Bearer plain-token').expect(403)
  })

  it('accepts an admin JWT', async () => {
    await request(build()).get('/view').set(adminAuthHeader).expect(200)
  })

  it('ignores x-admin-secret by default, even when it is correct', async () => {
    const res = await request(build()).get('/view').set('x-admin-secret', 'legacy-secret-value')
    expect(res.status).toBe(401)
  })

  it('accepts the legacy secret only when ALLOW_LEGACY_ADMIN_SECRET=true, and warns', async () => {
    process.env.ALLOW_LEGACY_ADMIN_SECRET = 'true'
    const warn = vi.spyOn(logger, 'warn')

    await request(build()).get('/view').set('x-admin-secret', 'legacy-secret-value').expect(200)
    await request(build()).get('/view').set('x-admin-secret', 'wrong').expect(403)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Legacy x-admin-secret'), expect.anything())
  })

  it('judges a request that carries a token on the token, not the legacy secret', async () => {
    process.env.ALLOW_LEGACY_ADMIN_SECRET = 'true'
    await request(build())
      .get('/view')
      .set('Authorization', 'Bearer not-a-real-token')
      .set('x-admin-secret', 'legacy-secret-value')
      .expect(401)
  })

  it('requires a recent sign-in for destructive actions', async () => {
    await request(build()).post('/drain').set(adminAuthHeader).expect(200)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + FRESH_AUTH_WINDOW_MS + 1000))
    const res = await request(build()).post('/drain').set(adminAuthHeader)

    expect([401, 403]).toContain(res.status)
    if (res.status === 403) expect(res.body.error.code).toBe('REAUTH_REQUIRED')
  })

  it('does not demand a fresh sign-in for ordinary admin actions', async () => {
    await request(build()).post('/act').set(adminAuthHeader).expect(200)
  })
})
