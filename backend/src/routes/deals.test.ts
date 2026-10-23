import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../app.js'
import { dealStore } from '../models/dealStore.js'
import { outboxStore } from '../outbox/store.js'
import { OutboxStatus, TxType } from '../outbox/types.js'
import { listingStore } from '../models/listingStore.js'
import { ListingStatus } from '../models/listing.js'
import { sessionStore, userStore } from '../models/authStore.js'

const TENANT_TOKEN = 'test-token-deals-tenant'
const LANDLORD_TOKEN = 'test-token-deals-landlord'
const OUTSIDER_TOKEN = 'test-token-deals-outsider'
const ADMIN_TOKEN = 'test-token-deals-admin'

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

describe('Deals API', () => {
  let app: any
  let tenantId: string
  let landlordId: string

  beforeEach(async () => {
    await dealStore.clear()
    app = createApp()

    sessionStore.clear()
    const tenant = await userStore.getOrCreateByEmail('deals-tenant@example.com')
    const landlord = await userStore.getOrCreateByEmail('deals-landlord@example.com')
    const outsider = await userStore.getOrCreateByEmail('deals-outsider@example.com')
    const admin = await userStore.getOrCreateByEmail('deals-admin@example.com')
    admin.role = 'admin'
    tenantId = tenant.id
    landlordId = landlord.id
    await sessionStore.create(tenant.email, TENANT_TOKEN)
    await sessionStore.create(landlord.email, LANDLORD_TOKEN)
    await sessionStore.create(outsider.email, OUTSIDER_TOKEN)
    await sessionStore.create(admin.email, ADMIN_TOKEN)
  })

  describe('authentication', () => {
    it('rejects requests without a bearer token on every deals route', async () => {
      const fakeId = '550e8400-e29b-41d4-a716-446655440999'
      const requests = [
        request(app).get('/api/deals'),
        request(app).get(`/api/deals/${fakeId}`),
        request(app).get(`/api/deals/${fakeId}/progress`),
        request(app).get(`/api/deals/${fakeId}/schedule`),
        request(app).post('/api/deals').send({}),
        request(app).patch(`/api/deals/${fakeId}/status`).send({ status: 'active' }),
        request(app).patch(`/api/deals/${fakeId}/schedule/1`).send({ status: 'paid' }),
        request(app).patch(`/api/deals/${fakeId}/repayment`).send({}),
      ]

      for (const pending of requests) {
        const response = await pending
        expect(response.status).toBe(401)
      }
    })

    it('ignores an x-user-id header when deciding who the caller is', async () => {
      const response = await request(app)
        .get('/api/deals')
        .set('x-user-id', tenantId)
        .expect(401)

      expect(response.body.error.code).toBe('UNAUTHORIZED')
    })
  })

  describe('POST /api/deals', () => {
    let approvedListingId: string

    beforeEach(async () => {
      await listingStore.clear()
      const listing = await listingStore.create({
        whistleblowerId: 'wb-001',
        address: '123 Test St',
        city: 'Lagos',
        area: 'Ikeja',
        bedrooms: 2,
        bathrooms: 2,
        annualRentNgn: 1200000,
        description: 'Test listing',
        photos: []
      })
      await listingStore.updateStatus(listing.listingId, ListingStatus.APPROVED)
      approvedListingId = listing.listingId
    })

    it('should create a new deal with valid data', async () => {
      const dealData = {
        tenantId,
        landlordId,
        listingId: approvedListingId,
        annualRentNgn: 1200000,
        depositNgn: 240000,
        termMonths: 12
      }

      const response = await request(app)
        .post('/api/deals')
        .set(bearer(TENANT_TOKEN))
        .send(dealData)
        .expect(201)

      expect(response.body.success).toBe(true)
      expect(response.body.data).toMatchObject({
        tenantId: dealData.tenantId,
        landlordId: dealData.landlordId,
        listingId: dealData.listingId,
        annualRentNgn: dealData.annualRentNgn,
        depositNgn: dealData.depositNgn,
        financedAmountNgn: 960000,
        termMonths: dealData.termMonths,
        status: 'draft'
      })
      expect(response.body.data.dealId).toBeDefined()
      expect(response.body.data.createdAt).toBeDefined()
      expect(response.body.data.schedule).toHaveLength(12)

      // Check schedule structure
      const firstPayment = response.body.data.schedule[0]
      expect(firstPayment).toMatchObject({
        period: 1,
        amountNgn: 80000,
        status: 'upcoming'
      })
      expect(firstPayment.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/)
    })

    it('rejects a deal the caller is not party to', async () => {
      const response = await request(app)
        .post('/api/deals')
        .set(bearer(OUTSIDER_TOKEN))
        .send({
          tenantId,
          landlordId,
          annualRentNgn: 1200000,
          depositNgn: 240000,
          termMonths: 12
        })
        .expect(403)

      expect(response.body.error.code).toBe('FORBIDDEN')
    })

    it('should reject deal with insufficient deposit', async () => {
      const dealData = {
        tenantId,
        landlordId,
        annualRentNgn: 1200000,
        depositNgn: 200000, // Only 16.67%, should be >= 20%
        termMonths: 12
      }

      const response = await request(app)
        .post('/api/deals')
        .set(bearer(TENANT_TOKEN))
        .send(dealData)
        .expect(400)

      expect(response.body.success).toBeUndefined()
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
      expect(response.body.error.message).toContain('Deposit must be at least 20%')
    })

    it('should reject deal with invalid term months', async () => {
      const dealData = {
        tenantId,
        landlordId,
        annualRentNgn: 1200000,
        depositNgn: 240000,
        termMonths: 9 // Invalid, should be 3, 6, or 12
      }

      const response = await request(app)
        .post('/api/deals')
        .set(bearer(TENANT_TOKEN))
        .send(dealData)
        .expect(400)

      expect(response.body.error.code).toBe('VALIDATION_ERROR')
      expect(response.body.error.message).toContain('Term months must be one of: 3, 6, 12')
    })

    it('should reject deal with missing required fields', async () => {
      const dealData = {
        tenantId,
        // Missing landlordId, annualRentNgn, depositNgn, termMonths
      }

      const response = await request(app)
        .post('/api/deals')
        .set(bearer(TENANT_TOKEN))
        .send(dealData)
        .expect(400)

      expect(response.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('should prevent race condition: only one deal created for concurrent requests on same listing', async () => {
      const dealData = {
        tenantId: 'tenant-001',
        landlordId: 'landlord-001',
        listingId: approvedListingId,
        annualRentNgn: 1200000,
        depositNgn: 240000,
        termMonths: 12
      }

      // Fire two concurrent requests
      const [response1, response2] = await Promise.all([
        request(app).post('/api/deals').set(bearer(ADMIN_TOKEN)).send({ ...dealData, tenantId: 'tenant-001' }),
        request(app).post('/api/deals').set(bearer(ADMIN_TOKEN)).send({ ...dealData, tenantId: 'tenant-002' }),
      ])

      // Exactly one should succeed (201), one should fail (409)
      const statuses = [response1.status, response2.status].sort()
      expect(statuses).toEqual([201, 409])

      // The successful response should have the deal
      const successResponse = response1.status === 201 ? response1 : response2
      expect(successResponse.body.success).toBe(true)
      expect(successResponse.body.data.listingId).toBe(approvedListingId)

      // The failed response should have the correct error
      const failResponse = response1.status === 409 ? response1 : response2
      expect(failResponse.body.error.code).toBe('LISTING_ALREADY_RENTED')
      expect(failResponse.body.error.message).toContain('already')

      // Verify only one deal exists for this listing
      const deals = await dealStore.findMany({ listingId: approvedListingId })
      expect(deals.total).toBe(1)
    })
  })

  describe('GET /api/deals/:dealId', () => {
    it('should return a specific deal with schedule', async () => {
      // First create a deal
      const createResponse = await request(app)
        .post('/api/deals')
        .set(bearer(TENANT_TOKEN))
        .send({
          tenantId,
          landlordId,
          annualRentNgn: 1200000,
          depositNgn: 240000,
          termMonths: 6
        })

      const dealId = createResponse.body.data.dealId

      // Then retrieve it
      const response = await request(app)
        .get(`/api/deals/${dealId}`)
        .set(bearer(TENANT_TOKEN))
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.data.dealId).toBe(dealId)
      expect(response.body.data.schedule).toHaveLength(6)
    })

    it('allows the landlord and admins, but not an outsider', async () => {
      const createResponse = await request(app)
        .post('/api/deals')
        .set(bearer(TENANT_TOKEN))
        .send({ tenantId, landlordId, annualRentNgn: 1200000, depositNgn: 240000, termMonths: 6 })
      const dealId = createResponse.body.data.dealId

      await request(app).get(`/api/deals/${dealId}`).set(bearer(LANDLORD_TOKEN)).expect(200)
      await request(app).get(`/api/deals/${dealId}`).set(bearer(ADMIN_TOKEN)).expect(200)

      const denied = await request(app)
        .get(`/api/deals/${dealId}`)
        .set(bearer(OUTSIDER_TOKEN))
        .expect(403)
      expect(denied.body.error.code).toBe('FORBIDDEN')
    })

    it('should return 404 for non-existent deal', async () => {
      const fakeId = '550e8400-e29b-41d4-a716-446655440999'

      const response = await request(app)
        .get(`/api/deals/${fakeId}`)
        .set(bearer(TENANT_TOKEN))
        .expect(404)

      expect(response.body.error.code).toBe('NOT_FOUND')
      expect(response.body.error.message).toContain(`Deal with ID ${fakeId} not found`)
    })
  })

  describe('GET /api/deals', () => {
    beforeEach(async () => {
      // Create some test deals
      await dealStore.create({
        tenantId,
        landlordId,
        annualRentNgn: 1200000,
        depositNgn: 240000,
        termMonths: 12
      })

      await dealStore.create({
        tenantId: 'tenant-002',
        landlordId: 'landlord-002',
        annualRentNgn: 2400000,
        depositNgn: 480000,
        termMonths: 6
      })
    })

    it('should return paginated list of deals to an admin', async () => {
      const response = await request(app)
        .get('/api/deals')
        .set(bearer(ADMIN_TOKEN))
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.data.deals).toHaveLength(2)
      expect(response.body.data.total).toBe(2)
      expect(response.body.data.page).toBe(1)
      expect(response.body.data.pageSize).toBe(20)
      expect(response.body.data.totalPages).toBe(1)
    })

    it('should filter deals by tenantId', async () => {
      const response = await request(app)
        .get(`/api/deals?tenantId=${tenantId}`)
        .set(bearer(ADMIN_TOKEN))
        .expect(200)

      expect(response.body.data.deals).toHaveLength(1)
      expect(response.body.data.deals[0].tenantId).toBe(tenantId)
    })

    it('should filter deals by landlordId', async () => {
      const response = await request(app)
        .get('/api/deals?landlordId=landlord-002')
        .set(bearer(ADMIN_TOKEN))
        .expect(200)

      expect(response.body.data.deals).toHaveLength(1)
      expect(response.body.data.deals[0].landlordId).toBe('landlord-002')
    })

    it('lets a party list only deals they are on', async () => {
      const response = await request(app)
        .get(`/api/deals?tenantId=${tenantId}`)
        .set(bearer(TENANT_TOKEN))
        .expect(200)

      expect(response.body.data.deals).toHaveLength(1)
      expect(response.body.data.deals[0].tenantId).toBe(tenantId)
    })

    it('refuses a party an unfiltered list or another party\'s deals', async () => {
      await request(app).get('/api/deals').set(bearer(TENANT_TOKEN)).expect(403)
      await request(app)
        .get('/api/deals?tenantId=tenant-002')
        .set(bearer(TENANT_TOKEN))
        .expect(403)
    })

    it('should support pagination', async () => {
      const response = await request(app)
        .get('/api/deals?page=1&pageSize=1')
        .set(bearer(ADMIN_TOKEN))
        .expect(200)

      expect(response.body.data.deals).toHaveLength(1)
      expect(response.body.data.page).toBe(1)
      expect(response.body.data.pageSize).toBe(1)
      expect(response.body.data.totalPages).toBe(2)
    })
  })

  describe('PATCH /api/deals/:dealId/status', () => {
    it('should update deal status', async () => {
      // Create a deal
      const createResponse = await request(app)
        .post('/api/deals')
        .set(bearer(TENANT_TOKEN))
        .send({
          tenantId,
          landlordId,
          annualRentNgn: 1200000,
          depositNgn: 240000,
          termMonths: 12
        })

      const dealId = createResponse.body.data.dealId

      // Update status
      const response = await request(app)
        .patch(`/api/deals/${dealId}/status`)
        .set(bearer(LANDLORD_TOKEN))
        .send({ status: 'active' })
        .expect(200)

      expect(response.body.success).toBe(true)
      expect(response.body.data.status).toBe('active')
    })

    it('rejects a status change from a non-party', async () => {
      const createResponse = await request(app)
        .post('/api/deals')
        .set(bearer(TENANT_TOKEN))
        .send({ tenantId, landlordId, annualRentNgn: 1200000, depositNgn: 240000, termMonths: 12 })
      const dealId = createResponse.body.data.dealId

      await request(app)
        .patch(`/api/deals/${dealId}/status`)
        .set(bearer(OUTSIDER_TOKEN))
        .send({ status: 'defaulted' })
        .expect(403)

      const deal = await dealStore.findById(dealId)
      expect(deal?.status).toBe('draft')
    })

    it('should return 404 for non-existent deal', async () => {
      const fakeId = '550e8400-e29b-41d4-a716-446655440999'

      const response = await request(app)
        .patch(`/api/deals/${fakeId}/status`)
        .set(bearer(TENANT_TOKEN))
        .send({ status: 'active' })
        .expect(404)

      expect(response.body.error.code).toBe('NOT_FOUND')
    })
  })

  describe('PATCH /api/deals/:dealId/schedule/:period', () => {
    it('should update schedule item status', async () => {
      // Create a deal
      const createResponse = await request(app)
        .post('/api/deals')
        .set(bearer(TENANT_TOKEN))
        .send({
          tenantId,
          landlordId,
          annualRentNgn: 1200000,
          depositNgn: 240000,
          termMonths: 3
        })

      const dealId = createResponse.body.data.dealId

      // Update first payment status
      const response = await request(app)
        .patch(`/api/deals/${dealId}/schedule/1`)
        .set(bearer(TENANT_TOKEN))
        .send({ status: 'paid' })
        .expect(200)

      expect(response.body.success).toBe(true)
      const firstPayment = response.body.data.schedule.find((item: any) => item.period === 1)
      expect(firstPayment.status).toBe('paid')
    })

    it('rejects a schedule update from a non-party', async () => {
      const createResponse = await request(app)
        .post('/api/deals')
        .set(bearer(TENANT_TOKEN))
        .send({ tenantId, landlordId, annualRentNgn: 1200000, depositNgn: 240000, termMonths: 3 })
      const dealId = createResponse.body.data.dealId

      await request(app)
        .patch(`/api/deals/${dealId}/schedule/1`)
        .set(bearer(OUTSIDER_TOKEN))
        .send({ status: 'paid' })
        .expect(403)

      const deal = await dealStore.findById(dealId)
      expect(deal?.schedule.find((item) => item.period === 1)?.status).toBe('upcoming')
    })

    it('should return 404 for non-existent deal', async () => {
      const fakeId = '550e8400-e29b-41d4-a716-446655440999'

      const response = await request(app)
        .patch(`/api/deals/${fakeId}/schedule/1`)
        .set(bearer(TENANT_TOKEN))
        .send({ status: 'paid' })
        .expect(404)

      expect(response.body.error.code).toBe('NOT_FOUND')
    })

    it('rejects a payment that would push rent-to-own equity over the property value', async () => {
      // termMonths=3 -> financedAmountNgn (960000) is split exactly across 3
      // periods, so accumulated equity hits the cap once all three are paid.
      const createResponse = await request(app)
        .post('/api/deals')
        .set(bearer(TENANT_TOKEN))
        .send({
          tenantId,
          landlordId,
          annualRentNgn: 1200000,
          depositNgn: 240000,
          termMonths: 3
        })

      const dealId = createResponse.body.data.dealId

      await request(app).patch(`/api/deals/${dealId}/schedule/1`).set(bearer(TENANT_TOKEN)).send({ status: 'paid' }).expect(200)
      await request(app).patch(`/api/deals/${dealId}/schedule/2`).set(bearer(TENANT_TOKEN)).send({ status: 'paid' }).expect(200)
      await request(app).patch(`/api/deals/${dealId}/schedule/3`).set(bearer(TENANT_TOKEN)).send({ status: 'paid' }).expect(200)

      // Accumulated equity now equals the cap (financedAmountNgn). Re-recording
      // period 1's payment mirrors a duplicate/replayed on-chain
      // record_equity_payment call and must be rejected before it is
      // accepted as "paid" — mirroring the rent_to_own contract's
      // EquityOverflow guard.
      const response = await request(app)
        .patch(`/api/deals/${dealId}/schedule/1`)
        .set(bearer(TENANT_TOKEN))
        .send({ status: 'paid' })
        .expect(409)

      expect(response.body.error.code).toBe('EQUITY_OVERFLOW')

      // The schedule item's status must be unchanged by the rejected request.
      const dealAfter = await request(app).get(`/api/deals/${dealId}`).set(bearer(TENANT_TOKEN)).expect(200)
      const period1 = dealAfter.body.data.schedule.find((item: any) => item.period === 1)
      expect(period1.status).toBe('paid')
    })
  })

  describe('GET /api/deals/:dealId/progress', () => {
    let dealId: string

    beforeEach(async () => {
      await outboxStore.clear()
      // Create a fresh deal for each test
      const createRes = await request(app)
        .post('/api/deals')
        .set(bearer(TENANT_TOKEN))
        .send({
          tenantId,
          landlordId,
          annualRentNgn: 1200000,
          depositNgn: 240000,
          termMonths: 12,
        })
      dealId = createRes.body.data.dealId
    })

    it('should return zero progress when no receipts exist', async () => {
      const response = await request(app)
        .get(`/api/deals/${dealId}/progress`)
        .set(bearer(TENANT_TOKEN))
        .expect(200)

      expect(response.body.success).toBe(true)
      const data = response.body.data
      expect(data.periodsPaid).toBe(0)
      expect(data.totalPaidUsdc).toBe('0.000000')
      expect(data.remainingPeriods).toBe(12)
      expect(data.nextDueDate).toBeDefined()
      expect(data.nextDueDate).not.toBeNull()
      expect(data.lastPaymentTxId).toBeUndefined()
    })

    it('should count only SENT TENANT_REPAYMENT receipts', async () => {
      // Create a SENT receipt
      const sentItem = await outboxStore.create({
        txType: TxType.TENANT_REPAYMENT,
        source: 'stripe',
        ref: 'pi_sent_001',
        payload: { dealId, amountUsdc: '64.52', tokenAddress: 'USDC_ADDR', txType: TxType.TENANT_REPAYMENT },
      })
      await outboxStore.updateStatus(sentItem.id, OutboxStatus.SENT)

      // Create a PENDING receipt (should NOT be counted)
      await outboxStore.create({
        txType: TxType.TENANT_REPAYMENT,
        source: 'stripe',
        ref: 'pi_pending_002',
        payload: { dealId, amountUsdc: '64.52', tokenAddress: 'USDC_ADDR', txType: TxType.TENANT_REPAYMENT },
      })

      // Create a FAILED receipt (should NOT be counted)
      const failedItem = await outboxStore.create({
        txType: TxType.TENANT_REPAYMENT,
        source: 'stripe',
        ref: 'pi_failed_003',
        payload: { dealId, amountUsdc: '64.52', tokenAddress: 'USDC_ADDR', txType: TxType.TENANT_REPAYMENT },
      })
      await outboxStore.updateStatus(failedItem.id, OutboxStatus.FAILED)

      const response = await request(app)
        .get(`/api/deals/${dealId}/progress`)
        .set(bearer(TENANT_TOKEN))
        .expect(200)

      const data = response.body.data
      expect(data.periodsPaid).toBe(1)
      expect(data.totalPaidUsdc).toBe('64.520000')
      expect(data.remainingPeriods).toBe(11)
      expect(data.lastPaymentTxId).toBe(sentItem.txId)
      expect(data.lastPaymentExternalRefSource).toBe('stripe')
      expect(data.lastPaymentExternalRef).toBe('pi_sent_001')
    })

    it('should sum multiple SENT receipts and pick the latest as last payment', async () => {
      const item1 = await outboxStore.create({
        txType: TxType.TENANT_REPAYMENT,
        source: 'stripe',
        ref: 'pi_aaa',
        payload: { dealId, amountUsdc: '50.00', tokenAddress: 'USDC_ADDR', txType: TxType.TENANT_REPAYMENT },
      })
      await outboxStore.updateStatus(item1.id, OutboxStatus.SENT)

      const item2 = await outboxStore.create({
        txType: TxType.TENANT_REPAYMENT,
        source: 'stellar',
        ref: 'txhash_bbb',
        payload: { dealId, amountUsdc: '79.04', tokenAddress: 'USDC_ADDR', txType: TxType.TENANT_REPAYMENT },
      })
      await outboxStore.updateStatus(item2.id, OutboxStatus.SENT)

      const response = await request(app)
        .get(`/api/deals/${dealId}/progress`)
        .set(bearer(TENANT_TOKEN))
        .expect(200)

      const data = response.body.data
      expect(data.periodsPaid).toBe(2)
      expect(data.totalPaidUsdc).toBe('129.040000')
      expect(data.remainingPeriods).toBe(10)
      expect(data.lastPaymentExternalRefSource).toBe('stellar')
      expect(data.lastPaymentExternalRef).toBe('txhash_bbb')
    })

    it('should not count LANDLORD_PAYOUT receipts', async () => {
      const item = await outboxStore.create({
        txType: TxType.LANDLORD_PAYOUT,
        source: 'manual',
        ref: 'payout_001',
        payload: { dealId, amountUsdc: '960.00', tokenAddress: 'USDC_ADDR', txType: TxType.LANDLORD_PAYOUT },
      })
      await outboxStore.updateStatus(item.id, OutboxStatus.SENT)

      const response = await request(app)
        .get(`/api/deals/${dealId}/progress`)
        .set(bearer(TENANT_TOKEN))
        .expect(200)

      expect(response.body.data.periodsPaid).toBe(0)
      expect(response.body.data.totalPaidUsdc).toBe('0.000000')
    })

    it('should return nextDueDate as null when fully paid', async () => {
      // Create 12 SENT receipts for a 12-month deal (= fully paid)
      for (let i = 0; i < 12; i++) {
        const item = await outboxStore.create({
          txType: TxType.TENANT_REPAYMENT,
          source: 'stripe',
          ref: `pi_period_${i}`,
          payload: { dealId, amountUsdc: '80000.00', tokenAddress: 'USDC_ADDR', txType: TxType.TENANT_REPAYMENT },
        })
        await outboxStore.updateStatus(item.id, OutboxStatus.SENT)
      }

      const response = await request(app)
        .get(`/api/deals/${dealId}/progress`)
        .set(bearer(TENANT_TOKEN))
        .expect(200)

      const data = response.body.data
      expect(data.periodsPaid).toBe(12)
      expect(data.remainingPeriods).toBe(0)
      expect(data.nextDueDate).toBeNull()
    })

    it('rejects progress reads from a non-party', async () => {
      await request(app)
        .get(`/api/deals/${dealId}/progress`)
        .set(bearer(OUTSIDER_TOKEN))
        .expect(403)
    })

    it('should return 404 for non-existent deal', async () => {
      const fakeId = '550e8400-e29b-41d4-a716-446655440999'
      const response = await request(app)
        .get(`/api/deals/${fakeId}/progress`)
        .set(bearer(TENANT_TOKEN))
        .expect(404)

      expect(response.body.error.code).toBe('NOT_FOUND')
    })
  })
})
