import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express, { type Request, type Response } from 'express'
import supertest from 'supertest'
import { idempotency, InMemoryIdempotencyStore } from './idempotency.js'

const KEY_1 = '11111111-1111-4111-8111-111111111111'
const KEY_2 = '22222222-2222-4222-8222-222222222222'

function buildApp(store: InMemoryIdempotencyStore, handler?: (req: Request, res: Response) => void) {
  const app = express()
  app.use(express.json())
  // Stands in for authenticateToken: the test caller is set from x-test-user, never trusted for real identity.
  app.use((req: Request, _res: Response, next) => {
    const testUser = req.headers['x-test-user']
    if (typeof testUser === 'string') {
      const authed = req as Request & { user?: { id: string } }
      authed.user = { id: testUser }
    }
    next()
  })

  let callCount = 0

  app.post('/test', idempotency(store), (req: Request, res: Response) => {
    callCount++
    if (handler) {
      handler(req, res)
      return
    }
    res.status(201).json({ created: true, callCount })
  })

  return { app, getCallCount: () => callCount }
}

describe('idempotency middleware', () => {
  let store: InMemoryIdempotencyStore

  beforeEach(() => {
    store = new InMemoryIdempotencyStore(60_000)
  })

  afterEach(() => {
    store.stop()
  })

  it('rejects requests without Idempotency-Key', async () => {
    const { app } = buildApp(store)
    const res = await supertest(app).post('/test').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toContain('Idempotency-Key')
    expect(res.body.error.details.documentationUrl).toContain('idempotency')
  })

  it('rejects requests with empty Idempotency-Key', async () => {
    const { app } = buildApp(store)
    const res = await supertest(app)
      .post('/test')
      .set('Idempotency-Key', '   ')
      .send({})
    expect(res.status).toBe(400)
  })

  it('rejects non-UUID Idempotency-Key values', async () => {
    const { app } = buildApp(store)
    const res = await supertest(app)
      .post('/test')
      .set('Idempotency-Key', 'not-a-uuid')
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('valid UUID')
  })

  it('allows the first request through', async () => {
    const { app, getCallCount } = buildApp(store)
    const res = await supertest(app)
      .post('/test')
      .set('Idempotency-Key', KEY_1)
      .send({})

    expect(res.status).toBe(201)
    expect(res.body.created).toBe(true)
    expect(getCallCount()).toBe(1)
  })

  it('replays cached response for duplicate key', async () => {
    const { app, getCallCount } = buildApp(store)

    const first = await supertest(app)
      .post('/test')
      .set('Idempotency-Key', KEY_1)
      .send({})
    expect(first.status).toBe(201)
    expect(first.body.callCount).toBe(1)

    const second = await supertest(app)
      .post('/test')
      .set('Idempotency-Key', KEY_1)
      .send({})

    expect(second.status).toBe(201)
    expect(second.body.callCount).toBe(1) // Same response as first
    expect(second.headers['x-idempotent-replay']).toBe('true')
    expect(getCallCount()).toBe(1) // Handler was NOT called again
  })

  it('allows different users with the same key through independently', async () => {
    const { app, getCallCount } = buildApp(store)

    await supertest(app)
      .post('/test')
      .set('x-test-user', 'user-a')
      .set('Idempotency-Key', KEY_1)
      .send({})

    await supertest(app)
      .post('/test')
      .set('x-test-user', 'user-b')
      .set('Idempotency-Key', KEY_1)
      .send({})

    expect(getCallCount()).toBe(2)
  })

  it('returns 409 while the same user and key is in-flight', async () => {
    let release!: () => void
    let markEntered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const { app, getCallCount } = buildApp(store, async (_req, res) => {
      markEntered()
      await gate
      res.status(201).json({ created: true })
    })

    const first = supertest(app)
      .post('/test')
      .set('x-test-user', 'user-a')
      .set('Idempotency-Key', KEY_2)
      .send({})
    const firstDone = first.then((res) => res)

    await entered

    const second = await supertest(app)
      .post('/test')
      .set('x-test-user', 'user-a')
      .set('Idempotency-Key', KEY_2)
      .send({})

    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('REQUEST_IN_FLIGHT')
    release()
    await firstDone
    expect(getCallCount()).toBe(1)
  })

  it('replays failed response without re-executing', async () => {
    const { app, getCallCount } = buildApp(store, (_req, res) => {
      res.status(400).json({ error: 'Invalid input' })
    })

    const first = await supertest(app)
      .post('/test')
      .set('Idempotency-Key', KEY_1)
      .send({})

    expect(first.status).toBe(400)
    expect(first.body.error).toBe('Invalid input')
    expect(getCallCount()).toBe(1)

    const second = await supertest(app)
      .post('/test')
      .set('Idempotency-Key', KEY_1)
      .send({})

    expect(second.status).toBe(400)
    expect(second.body.error).toBe('Invalid input')
    expect(second.headers['x-idempotent-replay']).toBe('true')
    expect(getCallCount()).toBe(1) // Handler was NOT called again
  })

  it('replays 500 error response without re-executing', async () => {
    const { app, getCallCount } = buildApp(store, (_req, res) => {
      res.status(500).json({ error: 'Internal server error' })
    })

    const first = await supertest(app)
      .post('/test')
      .set('Idempotency-Key', KEY_1)
      .send({})

    expect(first.status).toBe(500)
    expect(first.body.error).toBe('Internal server error')
    expect(getCallCount()).toBe(1)

    const second = await supertest(app)
      .post('/test')
      .set('Idempotency-Key', KEY_1)
      .send({})

    expect(second.status).toBe(500)
    expect(second.body.error).toBe('Internal server error')
    expect(second.headers['x-idempotent-replay']).toBe('true')
    expect(getCallCount()).toBe(1) // Handler was NOT called again
  })

  it('returns 409 when same key is used with different payload', async () => {
    const { app, getCallCount } = buildApp(store)

    const first = await supertest(app)
      .post('/test')
      .set('Idempotency-Key', KEY_1)
      .send({ amount: 100 })

    expect(first.status).toBe(201)
    expect(getCallCount()).toBe(1)

    const second = await supertest(app)
      .post('/test')
      .set('Idempotency-Key', KEY_1)
      .send({ amount: 200 }) // Different payload

    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('CONFLICT')
    expect(second.body.error.message).toContain('different request payload')
    expect(getCallCount()).toBe(1) // Handler was NOT called again
  })
})

describe('InMemoryIdempotencyStore', () => {
  it('evicts entries after TTL', async () => {
    const store = new InMemoryIdempotencyStore(50) // 50ms TTL

    store.set('temp', { status: 200, body: {}, createdAt: Date.now() - 100, payloadHash: 'hash' })
    expect(store.has('temp')).toBe(false)
    expect(store.get('temp')).toBeUndefined()

    store.stop()
  })

  it('tracks size correctly', () => {
    const store = new InMemoryIdempotencyStore(60_000)

    store.set('a', { status: 200, body: {}, createdAt: Date.now(), payloadHash: 'hash' })
    store.set('b', { status: 200, body: {}, createdAt: Date.now(), payloadHash: 'hash' })

    expect(store.size).toBe(2)
    store.stop()
  })
})
