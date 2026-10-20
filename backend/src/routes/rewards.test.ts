import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../app.js'
import { rewardStore } from '../models/rewardStore.js'
import { outboxStore } from '../outbox/store.js'
import { RewardStatus } from '../models/reward.js'
import { OutboxStatus, TxType } from '../outbox/types.js'
import { adminAuthHeader, seedAdminSession } from '../test-fixtures/adminAuth.js'

describe('POST /api/admin/rewards/:rewardId/mark-paid', () => {
  const app = createApp()

  beforeEach(async () => {
    await seedAdminSession()
    await rewardStore.clear()
    await outboxStore.clear()
  })

  const validMarkPaidRequest = {
    amountUsdc: 100,
    tokenAddress: 'USDC_CONTRACT_ADDRESS',
    externalRefSource: 'stripe',
    externalRef: 'pi_test123',
    amountNgn: 150000,
    fxRateNgnPerUsdc: 1500,
    fxProvider: 'coinbase',
  }

  it('should mark a payable reward as paid and create on-chain receipt', async () => {
    // Create a payable reward
    const reward = await rewardStore.create({
      whistleblowerId: 'wb-001',
      dealId: 'deal-001',
      listingId: 'listing-001',
      amountUsdc: 100,
    })
    await rewardStore.updateStatus(reward.rewardId, RewardStatus.PAYABLE)

    const response = await request.agent(app).set(adminAuthHeader)
      .post(`/api/admin/rewards/${reward.rewardId}/mark-paid`)
      .send(validMarkPaidRequest)

    expect(response.status).toBeGreaterThanOrEqual(200)
    expect(response.status).toBeLessThan(300)
    expect(response.body.success).toBe(true)
    expect(response.body.reward).toBeDefined()
    expect(response.body.reward.status).toBe(RewardStatus.PAID)
    expect(response.body.reward.paidAt).toBeDefined()
    expect(response.body.reward.paymentTxId).toBeDefined()
    expect(response.body.receipt).toBeDefined()
    expect(response.body.receipt.txId).toBeDefined()
    expect(['pending', 'sent', 'failed']).toContain(response.body.receipt.status)
  })

  it('should be idempotent when marking paid twice with same external ref', async () => {
    // Create two payable rewards
    const reward1 = await rewardStore.create({
      whistleblowerId: 'wb-001',
      dealId: 'deal-001',
      listingId: 'listing-001',
      amountUsdc: 100,
    })
    await rewardStore.updateStatus(reward1.rewardId, RewardStatus.PAYABLE)

    const reward2 = await rewardStore.create({
      whistleblowerId: 'wb-002',
      dealId: 'deal-002',
      listingId: 'listing-002',
      amountUsdc: 150,
    })
    await rewardStore.updateStatus(reward2.rewardId, RewardStatus.PAYABLE)

    // Mark first reward as paid
    const response1 = await request.agent(app).set(adminAuthHeader)
      .post(`/api/admin/rewards/${reward1.rewardId}/mark-paid`)
      .send(validMarkPaidRequest)

    expect(response1.status).toBeGreaterThanOrEqual(200)
    expect(response1.status).toBeLessThan(300)

    // Try to mark second reward with same external ref
    const response2 = await request.agent(app).set(adminAuthHeader)
      .post(`/api/admin/rewards/${reward2.rewardId}/mark-paid`)
      .send(validMarkPaidRequest)

    expect(response2.status).toBeGreaterThanOrEqual(200)
    expect(response2.status).toBeLessThan(300)

    // Both should have the same txId (idempotent)
    expect(response1.body.receipt.txId).toBe(response2.body.receipt.txId)
    expect(response1.body.receipt.outboxId).toBe(response2.body.receipt.outboxId)
  })

  it('should reject marking non-payable reward as paid', async () => {
    // Create a pending reward (not payable)
    const reward = await rewardStore.create({
      whistleblowerId: 'wb-001',
      dealId: 'deal-001',
      listingId: 'listing-001',
      amountUsdc: 100,
    })

    const response = await request.agent(app).set(adminAuthHeader)
      .post(`/api/admin/rewards/${reward.rewardId}/mark-paid`)
      .send(validMarkPaidRequest)
      .expect(409)

    expect(response.body.error).toBeDefined()
    expect(response.body.error.code).toBe('CONFLICT')
    expect(response.body.error.message).toContain('cannot be marked as paid')
    expect(response.body.error.details).toBeDefined()
    expect(response.body.error.details.currentStatus).toBe(RewardStatus.PENDING)
    expect(response.body.error.details.requiredStatus).toBe(RewardStatus.PAYABLE)
  })

  it('should reject marking already paid reward', async () => {
    // Create and mark reward as paid
    const reward = await rewardStore.create({
      whistleblowerId: 'wb-001',
      dealId: 'deal-001',
      listingId: 'listing-001',
      amountUsdc: 100,
    })
    await rewardStore.updateStatus(reward.rewardId, RewardStatus.PAYABLE)
    await rewardStore.markAsPaid(
      reward.rewardId,
      'existing-tx-id',
      'stripe',
      'pi_existing',
    )

    const response = await request.agent(app).set(adminAuthHeader)
      .post(`/api/admin/rewards/${reward.rewardId}/mark-paid`)
      .send(validMarkPaidRequest)
      .expect(409)

    expect(response.body.error).toBeDefined()
    expect(response.body.error.code).toBe('CONFLICT')
    expect(response.body.error.details.currentStatus).toBe(RewardStatus.PAID)
  })

  it('should return 404 for non-existent reward', async () => {
    const response = await request.agent(app).set(adminAuthHeader)
      .post('/api/admin/rewards/non-existent-id/mark-paid')
      .send(validMarkPaidRequest)
      .expect(404)

    expect(response.body.error).toBeDefined()
    expect(response.body.error.code).toBe('NOT_FOUND')
    expect(response.body.error.message).toContain('not found')
  })

  it('should reject invalid amount (zero)', async () => {
    const reward = await rewardStore.create({
      whistleblowerId: 'wb-001',
      dealId: 'deal-001',
      listingId: 'listing-001',
      amountUsdc: 100,
    })
    await rewardStore.updateStatus(reward.rewardId, RewardStatus.PAYABLE)

    const response = await request.agent(app).set(adminAuthHeader)
      .post(`/api/admin/rewards/${reward.rewardId}/mark-paid`)
      .send({
        ...validMarkPaidRequest,
        amountUsdc: 0,
      })
      .expect(400)

    expect(response.body.error).toBeDefined()
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('should reject invalid amount (negative)', async () => {
    const reward = await rewardStore.create({
      whistleblowerId: 'wb-001',
      dealId: 'deal-001',
      listingId: 'listing-001',
      amountUsdc: 100,
    })
    await rewardStore.updateStatus(reward.rewardId, RewardStatus.PAYABLE)

    const response = await request.agent(app).set(adminAuthHeader)
      .post(`/api/admin/rewards/${reward.rewardId}/mark-paid`)
      .send({
        ...validMarkPaidRequest,
        amountUsdc: -100,
      })
      .expect(400)

    expect(response.body.error).toBeDefined()
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('should reject missing required fields', async () => {
    const reward = await rewardStore.create({
      whistleblowerId: 'wb-001',
      dealId: 'deal-001',
      listingId: 'listing-001',
      amountUsdc: 100,
    })
    await rewardStore.updateStatus(reward.rewardId, RewardStatus.PAYABLE)

    const response = await request.agent(app).set(adminAuthHeader)
      .post(`/api/admin/rewards/${reward.rewardId}/mark-paid`)
      .send({
        amountUsdc: 100,
        // missing tokenAddress, externalRefSource, externalRef
      })
      .expect(400)

    expect(response.body.error).toBeDefined()
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('should create outbox item with correct payload structure', async () => {
    const reward = await rewardStore.create({
      whistleblowerId: 'wb-001',
      dealId: 'deal-001',
      listingId: 'listing-001',
      amountUsdc: 100,
    })
    await rewardStore.updateStatus(reward.rewardId, RewardStatus.PAYABLE)

    const response = await request.agent(app).set(adminAuthHeader)
      .post(`/api/admin/rewards/${reward.rewardId}/mark-paid`)
      .send(validMarkPaidRequest)

    expect(response.status).toBeGreaterThanOrEqual(200)
    expect(response.status).toBeLessThan(300)

    // Verify outbox item was created
    const outboxItem = await outboxStore.getById(response.body.receipt.outboxId)
    expect(outboxItem).toBeDefined()
    expect(outboxItem?.txType).toBe(TxType.WHISTLEBLOWER_REWARD)
    expect(outboxItem?.payload.dealId).toBe('deal-001')
    expect(outboxItem?.payload.listingId).toBe('listing-001')
    expect(outboxItem?.payload.whistleblowerId).toBe('wb-001')
    expect(outboxItem?.payload.amountUsdc).toBe(100)
    expect(outboxItem?.payload.tokenAddress).toBe('USDC_CONTRACT_ADDRESS')
    expect(outboxItem?.payload.amountNgn).toBe(150000)
    expect(outboxItem?.payload.fxRateNgnPerUsdc).toBe(1500)
    expect(outboxItem?.payload.fxProvider).toBe('coinbase')
  })

  it('should handle optional metadata fields', async () => {
    const reward = await rewardStore.create({
      whistleblowerId: 'wb-001',
      dealId: 'deal-001',
      listingId: 'listing-001',
      amountUsdc: 100,
    })
    await rewardStore.updateStatus(reward.rewardId, RewardStatus.PAYABLE)

    const response = await request.agent(app).set(adminAuthHeader)
      .post(`/api/admin/rewards/${reward.rewardId}/mark-paid`)
      .send({
        amountUsdc: 100,
        tokenAddress: 'USDC_CONTRACT_ADDRESS',
        externalRefSource: 'manual',
        externalRef: 'manual-payment-001',
        // No optional metadata
      })

    expect(response.status).toBeGreaterThanOrEqual(200)
    expect(response.status).toBeLessThan(300)

    const outboxItem = await outboxStore.getById(response.body.receipt.outboxId)
    expect(outboxItem?.payload.amountNgn).toBeUndefined()
    expect(outboxItem?.payload.fxRateNgnPerUsdc).toBeUndefined()
    expect(outboxItem?.payload.fxProvider).toBeUndefined()
  })
})
