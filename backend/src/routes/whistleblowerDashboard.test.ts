import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createApp } from '../app.js'
import { createWhistleblowerRouter } from './whistleblower.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { generateToken } from '../utils/tokens.js'
import { listingStore, MAX_REPORTS_PER_MONTH } from '../models/listingStore.js'
import { ListingStatus, type CreateListingInput } from '../models/listing.js'
import { whistleblowerRatingStore } from '../models/whistleblowerRatingStore.js'
import { notFound } from '../errors/AppError.js'
import type { EarningsService } from '../services/earnings.js'
import type { EarningsResponse } from '../schemas/whistleblower.js'

const listingFixture = (whistleblowerId: string, overrides: Partial<CreateListingInput> = {}): CreateListingInput => ({
  whistleblowerId,
  address: '12 Admiralty Way, Lekki',
  city: 'Lagos',
  area: 'Lekki',
  bedrooms: 2,
  bathrooms: 2,
  annualRentNgn: 2_400_000,
  photos: ['a.jpg', 'b.jpg', 'c.jpg'],
  ...overrides,
})

/** Earnings service backed by a fixture map; unknown whistleblowers 404 like the real one. */
function fixtureEarningsService(fixtures: Record<string, EarningsResponse>): EarningsService {
  return {
    async getEarnings(whistleblowerId: string) {
      const earnings = fixtures[whistleblowerId]
      if (!earnings) throw notFound('Whistleblower')
      return earnings
    },
  }
}

function buildApp(earningsService: EarningsService) {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/whistleblower', createWhistleblowerRouter(earningsService))
  app.use(errorHandler)
  return app
}

describe('GET /api/v1/whistleblower/dashboard', () => {
  let token: string
  let whistleblowerId: string

  beforeEach(async () => {
    await listingStore.clear()
    await whistleblowerRatingStore.clear()
    sessionStore.clear()
    userStore.clear()

    const user = await userStore.getOrCreateByEmail('whistleblower@test.com')
    whistleblowerId = user.id
    token = generateToken()
    await sessionStore.create(user.email, token)
  })

  it('requires authentication', async () => {
    const res = await request(buildApp(fixtureEarningsService({}))).get('/api/v1/whistleblower/dashboard')
    expect(res.status).toBe(401)
  })

  it('aggregates listings, earnings and ratings for the authenticated whistleblower', async () => {
    const active = await listingStore.create(listingFixture(whistleblowerId, { address: '1 Active St' }))
    await listingStore.updateStatus(active.listingId, ListingStatus.APPROVED)
    const rented = await listingStore.create(listingFixture(whistleblowerId, { address: '2 Rented Rd', annualRentNgn: 3_000_000, bedrooms: 3, bathrooms: 1 }))
    await listingStore.updateStatus(rented.listingId, ListingStatus.RENTED)
    // Another whistleblower's listing must not leak into this dashboard.
    await listingStore.create(listingFixture('someone-else', { address: '9 Other Ave' }))

    await whistleblowerRatingStore.create({ whistleblowerId, tenantId: 't1', dealId: 'd1', rating: 5 })
    await whistleblowerRatingStore.create({ whistleblowerId, tenantId: 't2', dealId: 'd2', rating: 4 })

    const earningsService = fixtureEarningsService({
      [whistleblowerId]: {
        totals: { totalNgn: 240_000, pendingNgn: 80_000, paidNgn: 160_000 },
        history: [
          {
            rewardId: 'r2', listingId: rented.listingId, dealId: 'deal-2', amountNgn: 80_000, amountUsdc: 50,
            status: 'payable', createdAt: '2026-10-02T10:00:00.000Z',
          },
          {
            rewardId: 'r1', listingId: rented.listingId, dealId: 'deal-1', amountNgn: 160_000, amountUsdc: 100,
            status: 'paid', createdAt: '2026-09-01T10:00:00.000Z', paidAt: '2026-09-05T10:00:00.000Z',
          },
        ],
      },
    })

    const res = await request(buildApp(earningsService))
      .get('/api/v1/whistleblower/dashboard')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.stats).toEqual({
      totalEarnings: 240_000,
      reportsThisMonth: 2,
      maxReportsPerMonth: MAX_REPORTS_PER_MONTH,
      activeListings: 1,
      rating: 4.5,
      reviews: 2,
    })

    expect(res.body.listings).toHaveLength(2)
    const byAddress = Object.fromEntries(res.body.listings.map((l: any) => [l.address, l]))
    expect(byAddress['1 Active St']).toEqual({
      id: active.listingId,
      address: '1 Active St',
      price: 2_400_000,
      beds: 2,
      baths: 2,
      status: 'active',
      views: 0,
      earnings: 0,
      postedDate: active.createdAt.toISOString().slice(0, 10),
    })
    expect(byAddress['2 Rented Rd']).toMatchObject({
      id: rented.listingId,
      price: 3_000_000,
      beds: 3,
      baths: 1,
      status: 'rented',
      earnings: 240_000,
    })

    expect(res.body.earnings).toEqual([
      { date: '2026-10-02', listing: '2 Rented Rd', amount: 80_000, status: 'pending' },
      { date: '2026-09-05', listing: '2 Rented Rd', amount: 160_000, status: 'completed' },
    ])
  })

  it('maps pending_review to pending and omits rejected listings', async () => {
    await listingStore.create(listingFixture(whistleblowerId, { address: 'Pending' }))
    const rejected = await listingStore.create(listingFixture(whistleblowerId, { address: 'Rejected' }))
    await listingStore.updateStatus(rejected.listingId, ListingStatus.REJECTED, 'Blurry photos')

    const res = await request(buildApp(fixtureEarningsService({})))
      .get('/api/v1/whistleblower/dashboard')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.listings.map((l: any) => [l.address, l.status])).toEqual([['Pending', 'pending']])
    expect(res.body.stats.activeListings).toBe(0)
    // Rejected reports still count against the monthly limit.
    expect(res.body.stats.reportsThisMonth).toBe(2)
  })

  it('returns zeroed stats for a whistleblower with no activity', async () => {
    const res = await request(buildApp(fixtureEarningsService({})))
      .get('/api/v1/whistleblower/dashboard')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      stats: {
        totalEarnings: 0,
        reportsThisMonth: 0,
        maxReportsPerMonth: MAX_REPORTS_PER_MONTH,
        activeListings: 0,
        rating: 0,
        reviews: 0,
      },
      listings: [],
      earnings: [],
    })
  })

  it('propagates non-404 earnings failures', async () => {
    const failing: EarningsService = {
      async getEarnings() {
        throw new Error('boom')
      },
    }
    const res = await request(buildApp(failing))
      .get('/api/v1/whistleblower/dashboard')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(500)
  })

  it('is mounted on the real app', async () => {
    const app = createApp()

    await request(app).get('/api/v1/whistleblower/dashboard').expect(401)

    const res = await request(app)
      .get('/api/v1/whistleblower/dashboard')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.stats.maxReportsPerMonth).toBe(MAX_REPORTS_PER_MONTH)
    expect(res.body.listings).toEqual([])
  })
})
