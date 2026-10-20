import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createRentGuaranteeRouter } from './rentGuarantee.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { dealStore } from '../models/dealStore.js'
import { InMemoryRentGuaranteeStore, canTransitionPolicy } from '../models/rentGuaranteeStore.js'
import {
  MockRentGuaranteeProvider,
  UnconfiguredRentGuaranteeProvider,
  createRentGuaranteeProvider,
} from '../services/insurance/index.js'

async function makeUser(email: string): Promise<{ id: string; token: string }> {
  const user = await userStore.getOrCreateByEmail(email)
  const session = await sessionStore.create(email, `token-${email}`)
  return { id: user.id, token: session.token }
}

async function makeDeal(landlordId: string, annualRentNgn = 1_200_000, termMonths = 12) {
  return dealStore.create({
    tenantId: 'tenant-1',
    landlordId,
    annualRentNgn,
    depositNgn: annualRentNgn * 0.2,
    termMonths,
  })
}

describe('Rent guarantee insurance (#1908)', () => {
  let app: express.Application
  let store: InMemoryRentGuaranteeStore
  let provider: MockRentGuaranteeProvider
  let landlord: { id: string; token: string }
  let other: { id: string; token: string }

  const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` })

  beforeEach(async () => {
    userStore.clear()
    sessionStore.clear()
    store = new InMemoryRentGuaranteeStore()
    provider = new MockRentGuaranteeProvider()
    landlord = await makeUser('rg-landlord@example.com')
    other = await makeUser('rg-other@example.com')

    app = express()
    app.use(requestIdMiddleware)
    app.use(express.json())
    app.use('/api/v1', createRentGuaranteeRouter({ store, provider }))
    app.use(errorHandler)
  })

  async function quote(u = landlord, dealId?: string) {
    const id = dealId ?? (await makeDeal(u.id)).dealId
    return request(app).post(`/api/v1/deals/${id}/rent-guarantee/quote`).set(auth(u))
  }

  describe('mock provider', () => {
    it('is deterministic', async () => {
      const req = { dealId: 'd1', landlordId: 'l1', annualRentNgn: 1_200_000, termMonths: 12, sequence: 1 }
      const a = await provider.quote(req)
      const b = await provider.quote(req)
      expect(a).toEqual(b)
      expect(a.premiumNgn).toBe(30_000)
      expect(a.coverageTermMonths).toBe(12)
      expect(a.policyNumber).toMatch(/^MOCK-RG-[0-9A-F]{12}$/)
    })

    it('pro-rates the premium by term', async () => {
      const q = await provider.quote({ dealId: 'd', landlordId: 'l', annualRentNgn: 1_200_000, termMonths: 6, sequence: 1 })
      expect(q.premiumNgn).toBe(15_000)
    })
  })

  describe('provider factory', () => {
    it('returns the mock for "mock"', () => {
      expect(createRentGuaranteeProvider('mock')).toBeInstanceOf(MockRentGuaranteeProvider)
    })

    it.each(['leatherback', 'heirs'] as const)('%s throws "not configured" on every operation', async (name) => {
      const p = createRentGuaranteeProvider(name)
      expect(p).toBeInstanceOf(UnconfiguredRentGuaranteeProvider)
      await expect(p.quote({} as never)).rejects.toThrow(/not configured/)
      await expect(p.bind({} as never)).rejects.toThrow(/not configured/)
      await expect(p.cancel({} as never)).rejects.toThrow(/not configured/)
      await expect(p.fileClaim({} as never, {} as never)).rejects.toThrow(/not configured/)
    })
  })

  describe('status transitions', () => {
    it.each([
      ['quoted', 'active', true],
      ['quoted', 'cancelled', true],
      ['quoted', 'claimed', false],
      ['active', 'cancelled', true],
      ['active', 'claimed', true],
      ['active', 'active', false],
      ['cancelled', 'active', false],
      ['claimed', 'cancelled', false],
    ] as const)('%s -> %s allowed=%s', (from, to, allowed) => {
      expect(canTransitionPolicy(from, to)).toBe(allowed)
    })
  })

  describe('full lifecycle with the mock provider', () => {
    it('quote -> bind -> claim', async () => {
      const q = await quote().then((r) => {
        expect(r.status).toBe(201)
        return r.body.policy
      })
      expect(q).toMatchObject({ status: 'quoted', provider: 'mock', premiumNgn: 30_000, coverageTermMonths: 12 })

      const bound = await request(app).post(`/api/v1/rent-guarantee/policies/${q.id}/bind`).set(auth(landlord)).expect(200)
      expect(bound.body.policy.status).toBe('active')
      expect(bound.body.policy.activatedAt).toBeTruthy()

      const claim = await request(app)
        .post(`/api/v1/rent-guarantee/policies/${q.id}/claims`)
        .set(auth(landlord))
        .send({ amountNgn: 100_000, reason: 'Tenant missed two consecutive payments' })
        .expect(201)
      expect(claim.body.claim).toMatchObject({ amountNgn: 100_000, status: 'submitted', policyId: q.id })
      expect(claim.body.policy.status).toBe('claimed')

      const list = await request(app).get('/api/v1/rent-guarantee/policies').set(auth(landlord)).expect(200)
      expect(list.body.policies).toHaveLength(1)
      expect(list.body.policies[0].status).toBe('claimed')
    })

    it('quote -> cancel, and a cancelled policy cannot be revived', async () => {
      const { policy } = (await quote()).body
      const cancelled = await request(app)
        .post(`/api/v1/rent-guarantee/policies/${policy.id}/cancel`)
        .set(auth(landlord))
        .send({ reason: 'Changed my mind' })
        .expect(200)
      expect(cancelled.body.policy).toMatchObject({ status: 'cancelled', cancellationReason: 'Changed my mind' })

      await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/bind`).set(auth(landlord)).expect(409)
    })

    it('bind -> cancel is allowed and notifies the provider', async () => {
      const cancelSpy = vi.spyOn(provider, 'cancel')
      const { policy } = (await quote()).body
      await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/bind`).set(auth(landlord)).expect(200)
      await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/cancel`).set(auth(landlord)).send({}).expect(200)
      expect(cancelSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('invalid transitions are rejected', () => {
    it('cannot claim a quoted policy', async () => {
      const { policy } = (await quote()).body
      const res = await request(app)
        .post(`/api/v1/rent-guarantee/policies/${policy.id}/claims`)
        .set(auth(landlord))
        .send({ amountNgn: 1000, reason: 'Not yet bound policy claim' })
        .expect(409)
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION')
    })

    it('cannot claim twice', async () => {
      const { policy } = (await quote()).body
      await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/bind`).set(auth(landlord)).expect(200)
      const body = { amountNgn: 1000, reason: 'Tenant defaulted on rent' }
      await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/claims`).set(auth(landlord)).send(body).expect(201)
      await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/claims`).set(auth(landlord)).send(body).expect(409)
    })

    it('cannot cancel a claimed or cancelled policy', async () => {
      const { policy } = (await quote()).body
      await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/cancel`).set(auth(landlord)).send({}).expect(200)
      await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/cancel`).set(auth(landlord)).send({}).expect(409)
    })

    it('rejects a claim above the annual rent', async () => {
      const { policy } = (await quote()).body
      await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/bind`).set(auth(landlord)).expect(200)
      await request(app)
        .post(`/api/v1/rent-guarantee/policies/${policy.id}/claims`)
        .set(auth(landlord))
        .send({ amountNgn: 5_000_000, reason: 'Tenant defaulted on rent' })
        .expect(400)
    })
  })

  describe('idempotent binding', () => {
    it('binding an active policy again returns it without calling the provider twice', async () => {
      const bindSpy = vi.spyOn(provider, 'bind')
      const { policy } = (await quote()).body
      const first = await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/bind`).set(auth(landlord)).expect(200)
      const second = await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/bind`).set(auth(landlord)).expect(200)
      expect(second.body.policy).toEqual(first.body.policy)
      expect(bindSpy).toHaveBeenCalledTimes(1)
    })

    it('replays the cached response for the same Idempotency-Key', async () => {
      const bindSpy = vi.spyOn(provider, 'bind')
      const { policy } = (await quote()).body
      const key = '3f1c5a9e-7d2b-4c8a-9e6f-1a2b3c4d5e6f'
      const first = await request(app)
        .post(`/api/v1/rent-guarantee/policies/${policy.id}/bind`)
        .set(auth(landlord))
        .set('Idempotency-Key', key)
        .expect(200)
      const replay = await request(app)
        .post(`/api/v1/rent-guarantee/policies/${policy.id}/bind`)
        .set(auth(landlord))
        .set('Idempotency-Key', key)
        .expect(200)
      expect(replay.headers['x-idempotent-replay']).toBe('true')
      expect(replay.body).toEqual(first.body)
      expect(bindSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('quoting', () => {
    it('re-quoting a deal returns the outstanding quote instead of duplicating it', async () => {
      const deal = await makeDeal(landlord.id)
      const a = await quote(landlord, deal.dealId)
      const b = await quote(landlord, deal.dealId)
      expect(a.status).toBe(201)
      expect(b.status).toBe(200)
      expect(b.body.policy.id).toBe(a.body.policy.id)
      expect(await store.countPoliciesForDeal(deal.dealId)).toBe(1)
    })

    it('refuses a new quote while the deal has an active policy', async () => {
      const deal = await makeDeal(landlord.id)
      const { policy } = (await quote(landlord, deal.dealId)).body
      await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/bind`).set(auth(landlord)).expect(200)
      await quote(landlord, deal.dealId).then((r) => expect(r.status).toBe(409))
    })

    it('allows a fresh quote after cancellation, with a distinct policy number', async () => {
      const deal = await makeDeal(landlord.id)
      const first = (await quote(landlord, deal.dealId)).body.policy
      await request(app).post(`/api/v1/rent-guarantee/policies/${first.id}/cancel`).set(auth(landlord)).send({}).expect(200)
      const again = await quote(landlord, deal.dealId)
      expect(again.status).toBe(201)
      expect(again.body.policy.id).not.toBe(first.id)
      expect(again.body.policy.policyNumber).not.toBe(first.policyNumber)
    })
  })

  describe('ownership', () => {
    it("404s when quoting someone else's deal", async () => {
      const deal = await makeDeal(landlord.id)
      await quote(other, deal.dealId).then((r) => expect(r.status).toBe(404))
    })

    it("404s on another landlord's policy for bind, cancel and claims, and leaves it untouched", async () => {
      const { policy } = (await quote()).body
      await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/bind`).set(auth(other)).expect(404)
      await request(app).post(`/api/v1/rent-guarantee/policies/${policy.id}/cancel`).set(auth(other)).send({}).expect(404)
      await request(app)
        .post(`/api/v1/rent-guarantee/policies/${policy.id}/claims`)
        .set(auth(other))
        .send({ amountNgn: 1000, reason: 'Trying to claim a stranger policy' })
        .expect(404)
      expect((await store.findPolicyById(policy.id))!.status).toBe('quoted')
    })

    it('lists only the caller\'s own policies', async () => {
      await quote(landlord)
      await quote(other)
      const mine = await request(app).get('/api/v1/rent-guarantee/policies').set(auth(landlord)).expect(200)
      const theirs = await request(app).get('/api/v1/rent-guarantee/policies').set(auth(other)).expect(200)
      expect(mine.body.policies).toHaveLength(1)
      expect(theirs.body.policies).toHaveLength(1)
      expect(mine.body.policies[0].id).not.toBe(theirs.body.policies[0].id)
    })

    it('requires authentication', async () => {
      await request(app).get('/api/v1/rent-guarantee/policies').expect(401)
      await request(app).post('/api/v1/deals/00000000-0000-4000-8000-000000000000/rent-guarantee/quote').expect(401)
    })
  })

  it('surfaces "not configured" as 501 for real providers', async () => {
    const unconfigured = express()
    unconfigured.use(requestIdMiddleware)
    unconfigured.use(express.json())
    unconfigured.use(
      '/api/v1',
      createRentGuaranteeRouter({ store, provider: new UnconfiguredRentGuaranteeProvider('heirs') }),
    )
    unconfigured.use(errorHandler)

    const deal = await makeDeal(landlord.id)
    const res = await request(unconfigured)
      .post(`/api/v1/deals/${deal.dealId}/rent-guarantee/quote`)
      .set(auth(landlord))
    expect(res.status).toBe(501)
    expect(await store.countPoliciesForDeal(deal.dealId)).toBe(0)
  })
})
