import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { createWebhooksRouter } from './webhooks.js'
import { NgnWalletService } from '../services/ngnWalletService.js'
import { ngnWalletStore } from '../models/ngnWalletStore.js'
import { userRiskStateStore } from '../models/userRiskStateStore.js'
import { webhookEventDedupeStore } from '../models/webhookEventDedupeStore.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { seedNgnWalletFixture } from '../test-fixtures/ngnWalletFixtures.js'
import { payoutReferenceFor } from '../jobs/withdrawalPayoutWorker.js'
import { ngnWithdrawalStore } from '../models/ngnWithdrawalStore.js'

describe('Webhooks - withdrawal payout results', () => {
  let app: Express
  let service: NgnWalletService
  const userId = 'payout-webhook-user'
  const bankAccount = { accountNumber: '1234567890', accountName: 'Test User', bankName: 'Test Bank' }

  beforeEach(async () => {
    await ngnWithdrawalStore.clear()
    service = new NgnWalletService()
    await ngnWalletStore.clear()
    userRiskStateStore.clear()
    webhookEventDedupeStore.clear()
    await seedNgnWalletFixture(userId)

    app = express()
    app.use(express.json())
    app.use((req: any, _res, next) => {
      req.requestId = 'test-request-id'
      next()
    })
    app.use('/api/webhooks', createWebhooksRouter(service))
    app.use(errorHandler)

    process.env.WEBHOOK_SIGNATURE_ENABLED = 'false'
  })

  async function processingWithdrawal() {
    const withdrawal = await service.initiateWithdrawal(userId, { amountNgn: 2000, bankAccount })
    await service.approveWithdrawal(withdrawal.id)
    await service.claimForPayout(withdrawal.id)
    return withdrawal
  }

  it('confirms a processing withdrawal when the PSP reports success', async () => {
    const withdrawal = await processingWithdrawal()

    const res = await request(app)
      .post('/api/webhooks/payouts/psp')
      .send({
        externalRefSource: 'psp',
        externalRef: payoutReferenceFor(withdrawal.id),
        status: 'confirmed',
        providerEventId: 'evt-payout-1',
      })
      .expect(200)

    expect(res.body.success).toBe(true)
    expect((await service.getWithdrawal(withdrawal.id))?.status).toBe('confirmed')
  })

  it('a duplicate delivery is deduplicated and does not confirm twice', async () => {
    const withdrawal = await processingWithdrawal()
    const payload = {
      externalRefSource: 'psp',
      externalRef: payoutReferenceFor(withdrawal.id),
      status: 'confirmed',
      providerEventId: 'evt-payout-dup',
    }

    await request(app).post('/api/webhooks/payouts/psp').send(payload).expect(200)
    const replay = await request(app).post('/api/webhooks/payouts/psp').send(payload).expect(200)

    expect(replay.body.deduped).toBe(true)
    const ledger = await service.getLedger(userId, { limit: 100 })
    expect(ledger.entries.filter((e) => e.type === 'WITHDRAWAL_CONFIRMED')).toHaveLength(1)
  })

  it('releases the held balance when the PSP reports failure', async () => {
    const withdrawal = await processingWithdrawal()

    await request(app)
      .post('/api/webhooks/payouts/psp')
      .send({
        externalRefSource: 'psp',
        externalRef: payoutReferenceFor(withdrawal.id),
        status: 'failed',
        providerEventId: 'evt-payout-fail',
      })
      .expect(200)

    expect((await service.getWithdrawal(withdrawal.id))?.status).toBe('failed')
    expect((await service.getBalance(userId)).availableNgn).toBe(50000)
  })

  it('returns 404 for a reference that does not match a withdrawal', async () => {
    await request(app)
      .post('/api/webhooks/payouts/psp')
      .send({
        externalRefSource: 'psp',
        externalRef: 'payout-does-not-exist',
        status: 'confirmed',
        providerEventId: 'evt-payout-unknown',
      })
      .expect(404)
  })
})
