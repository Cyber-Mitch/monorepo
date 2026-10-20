import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { errorHandler } from '../middleware/errorHandler.js'
import { createAdminRouter } from './admin.js'
import { SorobanAdapter } from '../soroban/adapter.js'
import { outboxStore, OutboxStatus } from '../outbox/index.js'
import { rewardStore } from '../models/rewardStore.js'
import { listingStore } from '../models/listingStore.js'
import { kycRepository } from '../repositories/KycRepository.js'
import { paymentDisputeRepository } from '../repositories/PaymentDisputeRepository.js'
import { ReceiptIndexer } from '../indexer/worker.js'
import { RewardStatus } from '../models/reward.js'
import { ListingStatus } from '../models/listing.js'
import { adminAuthHeader, seedAdminSession } from '../test-fixtures/adminAuth.js'

vi.mock('../soroban/adapter.js', () => ({
  SorobanAdapter: vi.fn().mockImplementation(() => ({
    sendTransaction: vi.fn(),
  })) as any,
}))

vi.mock('../outbox/index.js', () => ({
  outboxStore: {
    getHealthSummary: vi.fn(),
    listByStatus: vi.fn(),
    listAll: vi.fn(),
    getById: vi.fn(),
    markDead: vi.fn(),
    create: vi.fn(),
  },
  OutboxSender: class {
    retry = vi.fn().mockResolvedValue(true)
    retryAll = vi.fn().mockResolvedValue({ succeeded: 5, failed: 2 })
    send = vi.fn()
    constructor() {}
  },
  OutboxStatus: {
    PENDING: 'pending',
    SENT: 'sent',
    FAILED: 'failed',
    DEAD: 'dead',
  },
  TxType: {
    WHISTLEBLOWER_REWARD: 'whistleblower_reward',
  },
}))

vi.mock('../models/rewardStore.js', () => ({
  rewardStore: {
    getById: vi.fn(),
    markAsPaid: vi.fn(),
  },
}))

vi.mock('../models/listingStore.js', () => ({
  listingStore: {
    list: vi.fn(),
    getById: vi.fn(),
    moderate: vi.fn(),
  },
}))

vi.mock('../repositories/KycRepository.js', () => ({
  kycRepository: {
    findById: vi.fn(),
    findByUserId: vi.fn(),
    updateStatus: vi.fn(),
  },
}))

vi.mock('../repositories/PaymentDisputeRepository.js', () => ({
  paymentDisputeRepository: {
    findById: vi.fn(),
    updateStatus: vi.fn(),
  },
}))

vi.mock('../indexer/worker.js', () => ({
  ReceiptIndexer: vi.fn().mockImplementation(() => ({
    getMetrics: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  })),
}))

vi.mock('../schemas/env.js', () => ({
  env: {
    MANUAL_ADMIN_SECRET: 'test-secret',
    CUSTODIAL_MODE_ENABLED: false,
    CUSTODIAL_SIGNING_PAUSED: false,
    WEBHOOK_SIGNATURE_ENABLED: true,
    SOROBAN_NETWORK: 'testnet',
  },
}))

vi.mock('../utils/auditLogger.js', () => ({
  auditAdminWalletAction: vi.fn(),
  auditListingApproved: vi.fn(),
  auditListingRejected: vi.fn(),
  auditRewardMarkedPaid: vi.fn(),
  auditAdminOutboxMarkDead: vi.fn(),
  auditAdminOutboxRetry: vi.fn(),
  auditLog: vi.fn(),
  extractAuditContext: vi.fn(() => ({})),
}))

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../db.js', () => ({
  getPool: vi.fn(async () => null),
}))

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => {
    req.requestId = 'test-request-id'
    next()
  })
  app.use('/api/admin', createAdminRouter({} as any))
  app.use(errorHandler)
  return app
}

describe('Admin Routes', () => {
  beforeEach(async () => {
    await seedAdminSession()
  })

  describe('GET /api/admin/flags', () => {
    it('should reject request without authentication', async () => {
      const res = await request(buildApp()).get('/api/admin/flags')

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHORIZED')
    })

    it('should reject request with an invalid token', async () => {
      const res = await request(buildApp())
        .get('/api/admin/flags')
        .set('Authorization', 'Bearer not-a-real-token')

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('INVALID_TOKEN')
    })
  })

  describe('GET /api/admin/outbox/health', () => {
    it('should reject request without authentication', async () => {
      const res = await request(buildApp()).get('/api/admin/outbox/health')

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHORIZED')
    })
  })

  describe('GET /api/admin/outbox/dead-letter', () => {
    it('should reject request without authentication', async () => {
      const res = await request(buildApp()).get('/api/admin/outbox/dead-letter')

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHORIZED')
    })
  })

  describe('GET /api/admin/outbox', () => {
    it('should reject request without authentication', async () => {
      const res = await request(buildApp()).get('/api/admin/outbox')

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHORIZED')
    })
  })

  describe('POST /api/admin/outbox/:id/mark-dead', () => {
    it('should reject request without authentication', async () => {
      const res = await request(buildApp())
        .post('/api/admin/outbox/outbox-3/mark-dead')
        .send({ reason: 'Test' })

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHORIZED')
    })
  })

  describe('POST /api/admin/outbox/:id/retry', () => {
    it('should reject request without authentication', async () => {
      const res = await request(buildApp()).post('/api/admin/outbox/outbox-5/retry')

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHORIZED')
    })
  })

  describe('POST /api/admin/outbox/retry-all', () => {
    it('should reject request without authentication', async () => {
      const res = await request(buildApp()).post('/api/admin/outbox/retry-all')

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHORIZED')
    })
  })

  describe('GET /api/admin/whistleblower/listings', () => {
    it('should list whistleblower listings', async () => {
      vi.mocked(listingStore.list).mockResolvedValue({
        listings: [
          {
            listingId: 'listing-1',
            whistleblowerId: 'user-123',
            address: '123 Main St',
            city: 'Lagos',
            area: 'Ikeja',
            bedrooms: 3,
            bathrooms: 2,
            annualRentNgn: 500000,
            outrightPriceNgn: 10000000,
            installmentBasePriceNgn: 2000000,
            negotiatedLandlordRateNgn: 450000,
            description: 'Nice apartment',
            photos: [],
            status: ListingStatus.PENDING_REVIEW,
            reviewedBy: undefined,
            reviewedAt: undefined,
            rejectionReason: undefined,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      })

      const res = await request.agent(buildApp()).set(adminAuthHeader)
        .get('/api/admin/whistleblower/listings')

      expect(res.status).toBe(200)
      expect(res.body.listings).toBeInstanceOf(Array)
      expect(res.body.pagination).toMatchObject({
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      })
    })

    it('should support status filter', async () => {
      vi.mocked(listingStore.list).mockResolvedValue({
        listings: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
      })

      const res = await request.agent(buildApp()).set(adminAuthHeader)
        .get('/api/admin/whistleblower/listings?status=approved')

      expect(res.status).toBe(200)
    })

    it('should support pagination', async () => {
      vi.mocked(listingStore.list).mockResolvedValue({
        listings: [],
        total: 100,
        page: 2,
        pageSize: 50,
        totalPages: 2,
      })

      const res = await request.agent(buildApp()).set(adminAuthHeader)
        .get('/api/admin/whistleblower/listings?page=2&pageSize=50')

      expect(res.status).toBe(200)
    })
  })

  describe('POST /api/admin/whistleblower/listings/:id/approve', () => {
    it('should approve a listing', async () => {
      vi.mocked(listingStore.getById).mockResolvedValue({
        listingId: 'listing-2',
        whistleblowerId: 'user-456',
        status: ListingStatus.PENDING_REVIEW,
        createdAt: new Date(),
        updatedAt: new Date(),
        address: '123 Main St',
        city: 'Lagos',
        area: 'Ikeja',
        bedrooms: 3,
        bathrooms: 2,
        annualRentNgn: 500000,
        outrightPriceNgn: 10000000,
        installmentBasePriceNgn: 2000000,
        negotiatedLandlordRateNgn: 450000,
        description: 'Nice apartment',
        photos: [],
        reviewedBy: undefined,
        reviewedAt: undefined,
        rejectionReason: undefined,
      } as any)

      vi.mocked(kycRepository.findByUserId).mockResolvedValue({
        status: 'approved',
      } as any)

      vi.mocked(listingStore.moderate).mockResolvedValue({
        listingId: 'listing-2',
        status: ListingStatus.APPROVED,
        reviewedBy: 'admin-1',
        reviewedAt: new Date(),
        updatedAt: new Date(),
        whistleblowerId: 'user-456',
        address: '123 Main St',
        city: 'Lagos',
        area: 'Ikeja',
        bedrooms: 3,
        bathrooms: 2,
        annualRentNgn: 500000,
        outrightPriceNgn: 10000000,
        installmentBasePriceNgn: 2000000,
        negotiatedLandlordRateNgn: 450000,
        description: 'Nice apartment',
        photos: [],
        rejectionReason: undefined,
      } as any)

      const res = await request.agent(buildApp()).set(adminAuthHeader)
        .post('/api/admin/whistleblower/listings/listing-2/approve')
        .send({ reviewedBy: 'admin-1' })

      expect(res.status).toBe(200)
      expect(res.body.listing.status).toBe(ListingStatus.APPROVED)
    })

    it('should return 404 for non-existent listing', async () => {
      vi.mocked(listingStore.getById).mockResolvedValue(null)

      const res = await request.agent(buildApp()).set(adminAuthHeader)
        .post('/api/admin/whistleblower/listings/non-existent/approve')
        .send({ reviewedBy: 'admin-1' })

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
    })

    it('should return conflict for non-pending listing', async () => {
      vi.mocked(listingStore.getById).mockResolvedValue({
        listingId: 'listing-3',
        whistleblowerId: 'user-789',
        status: ListingStatus.APPROVED,
        createdAt: new Date(),
        updatedAt: new Date(),
        address: '456 Oak Ave',
        city: 'Lagos',
        area: 'Victoria Island',
        bedrooms: 2,
        bathrooms: 1,
        annualRentNgn: 400000,
        outrightPriceNgn: 8000000,
        installmentBasePriceNgn: 1600000,
        negotiatedLandlordRateNgn: 380000,
        description: 'Modern apartment',
        photos: [],
        reviewedBy: 'admin-1',
        reviewedAt: new Date(),
        rejectionReason: undefined,
      } as any)

      vi.mocked(kycRepository.findByUserId).mockResolvedValue({
        status: 'approved',
      } as any)

      const res = await request.agent(buildApp()).set(adminAuthHeader)
        .post('/api/admin/whistleblower/listings/listing-3/approve')
        .send({ reviewedBy: 'admin-1' })

      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('CONFLICT')
    })

    it('should reject when landlord KYC is not approved', async () => {
      vi.mocked(listingStore.getById).mockResolvedValue({
        listingId: 'listing-4',
        whistleblowerId: 'user-999',
        status: ListingStatus.PENDING_REVIEW,
        createdAt: new Date(),
        updatedAt: new Date(),
        address: '789 Pine St',
        city: 'Lagos',
        area: 'Lekki',
        bedrooms: 4,
        bathrooms: 3,
        annualRentNgn: 600000,
        outrightPriceNgn: 12000000,
        installmentBasePriceNgn: 2400000,
        negotiatedLandlordRateNgn: 550000,
        description: 'Luxury apartment',
        photos: [],
        reviewedBy: undefined,
        reviewedAt: undefined,
        rejectionReason: undefined,
      } as any)

      vi.mocked(kycRepository.findByUserId).mockResolvedValue({
        status: 'pending',
      } as any)

      const res = await request.agent(buildApp()).set(adminAuthHeader)
        .post('/api/admin/whistleblower/listings/listing-4/approve')
        .send({ reviewedBy: 'admin-1' })

      expect(res.status).toBe(403)
      expect(res.body.error.message).toBe('LANDLORD_KYC_REQUIRED')
    })
  })

  describe('POST /api/admin/whistleblower/listings/:id/reject', () => {
    it('should reject a listing', async () => {
      vi.mocked(listingStore.getById).mockResolvedValue({
        listingId: 'listing-5',
        whistleblowerId: 'user-111',
        status: ListingStatus.PENDING_REVIEW,
        createdAt: new Date(),
        updatedAt: new Date(),
        address: '321 Elm St',
        city: 'Lagos',
        area: 'Yaba',
        bedrooms: 2,
        bathrooms: 1,
        annualRentNgn: 350000,
        outrightPriceNgn: 7000000,
        installmentBasePriceNgn: 1400000,
        negotiatedLandlordRateNgn: 330000,
        description: 'Cozy apartment',
        photos: [],
        reviewedBy: undefined,
        reviewedAt: undefined,
        rejectionReason: undefined,
      } as any)

      vi.mocked(listingStore.moderate).mockResolvedValue({
        listingId: 'listing-5',
        status: ListingStatus.REJECTED,
        reviewedBy: 'admin-1',
        reviewedAt: new Date(),
        rejectionReason: 'Invalid photos',
        updatedAt: new Date(),
        whistleblowerId: 'user-111',
        address: '321 Elm St',
        city: 'Lagos',
        area: 'Yaba',
        bedrooms: 2,
        bathrooms: 1,
        annualRentNgn: 350000,
        outrightPriceNgn: 7000000,
        installmentBasePriceNgn: 1400000,
        negotiatedLandlordRateNgn: 330000,
        description: 'Cozy apartment',
        photos: [],
      } as any)

      const res = await request.agent(buildApp()).set(adminAuthHeader)
        .post('/api/admin/whistleblower/listings/listing-5/reject')
        .send({ reviewedBy: 'admin-1', reason: 'Invalid photos' })

      expect(res.status).toBe(200)
      expect(res.body.listing.status).toBe(ListingStatus.REJECTED)
      expect(res.body.listing.rejectionReason).toBe('Invalid photos')
    })

    it('should return 404 for non-existent listing', async () => {
      vi.mocked(listingStore.getById).mockResolvedValue(null)

      const res = await request.agent(buildApp()).set(adminAuthHeader)
        .post('/api/admin/whistleblower/listings/non-existent/reject')
        .send({ reviewedBy: 'admin-1', reason: 'Test' })

      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
    })

    it('should return conflict for non-pending listing', async () => {
      vi.mocked(listingStore.getById).mockResolvedValue({
        listingId: 'listing-6',
        whistleblowerId: 'user-222',
        status: ListingStatus.APPROVED,
        createdAt: new Date(),
        updatedAt: new Date(),
        address: '555 Maple Dr',
        city: 'Lagos',
        area: 'Ikeja',
        bedrooms: 3,
        bathrooms: 2,
        annualRentNgn: 450000,
        outrightPriceNgn: 9000000,
        installmentBasePriceNgn: 1800000,
        negotiatedLandlordRateNgn: 420000,
        description: 'Spacious apartment',
        photos: [],
        reviewedBy: 'admin-1',
        reviewedAt: new Date(),
        rejectionReason: undefined,
      } as any)

      const res = await request.agent(buildApp()).set(adminAuthHeader)
        .post('/api/admin/whistleblower/listings/listing-6/reject')
        .send({ reviewedBy: 'admin-1', reason: 'Test' })

      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('CONFLICT')
    })
  })
})
