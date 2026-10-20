import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { createAdminWithdrawalsRouter } from './adminWithdrawals.js'
import { NgnWalletService } from '../services/ngnWalletService.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { seedNgnWalletFixture } from '../test-fixtures/ngnWalletFixtures.js'
import { ngnWithdrawalStore } from '../models/ngnWithdrawalStore.js'
import { ngnWalletStore } from '../models/ngnWalletStore.js'
import { AppError } from '../errors/AppError.js'

import { getPool } from '../db.js'

describe('Admin Withdrawals Routes', () => {
  let app: Express
  let ngnWalletService: NgnWalletService
  let authToken: string
  let userId: string

  beforeEach(async () => {
    await ngnWithdrawalStore.clear()
    await ngnWalletStore.clear()
    ngnWalletService = new NgnWalletService()

    userStore.clear()
    sessionStore.clear()

    const adminUser = await userStore.getOrCreateByEmail('admin@test.com')
    userId = adminUser.id
    adminUser.role = 'super_admin' // Legacy/test fallback for in-memory store

    // Grant super_admin role in DB for RBAC check
    const pool = await getPool()
    if (pool) {
      await pool.query(`INSERT INTO roles (name, description) VALUES ('super_admin', 'Super admin role') ON CONFLICT (name) DO NOTHING`)
      const { rows: roleRows } = await pool.query(`SELECT id FROM roles WHERE name = 'super_admin'`)
      if (roleRows.length > 0) {
        await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, roleRows[0].id])
      }
    }

    const testToken = `test-token-${Date.now()}`
    const session = await sessionStore.create('admin@test.com', testToken)
    authToken = session.token

    app = express()
    app.use(express.json())
    app.use('/api/admin', createAdminWithdrawalsRouter(ngnWalletService))
    app.use(errorHandler)
  })

  it('should approve a pending withdrawal idempotently', async () => {
    const user = await userStore.getOrCreateByEmail('user1@test.com')
    await seedNgnWalletFixture(user.id)

    const initiated = await ngnWalletService.initiateWithdrawal(user.id, {
      amountNgn: 1000,
      bankAccount: {
        accountNumber: '1234567890',
        accountName: 'Test User',
        bankName: 'Test Bank',
      },
    })

    const first = await request(app)
      .post(`/api/admin/withdrawals/${initiated.id}/approve`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)

    expect(first.body.success).toBe(true)
    expect(first.body.status).toBe('approved')

    const second = await request(app)
      .post(`/api/admin/withdrawals/${initiated.id}/approve`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)

    expect(second.body.status).toBe('approved')
  })

  it('should reject a pending withdrawal idempotently', async () => {
    const user = await userStore.getOrCreateByEmail('user2@test.com')
    await seedNgnWalletFixture(user.id)

    const initiated = await ngnWalletService.initiateWithdrawal(user.id, {
      amountNgn: 1000,
      bankAccount: {
        accountNumber: '1234567890',
        accountName: 'Test User',
        bankName: 'Test Bank',
      },
    })

    const first = await request(app)
      .post(`/api/admin/withdrawals/${initiated.id}/reject`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reason: 'Risk' })
      .expect(200)

    expect(first.body.success).toBe(true)
    expect(first.body.status).toBe('rejected')

    const second = await request(app)
      .post(`/api/admin/withdrawals/${initiated.id}/reject`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reason: 'Risk' })
      .expect(200)

    expect(second.body.status).toBe('rejected')
  })

  describe('persistence, ledger and list (#1944)', () => {
    const bankAccount = { accountNumber: '1234567890', accountName: 'Test User', bankName: 'Test Bank' }

    async function funded(email: string, amount = 10_000) {
      const user = await userStore.getOrCreateByEmail(email)
      await seedNgnWalletFixture(user.id)
      return user.id
    }
    const balanceOf = (id: string) => ngnWalletService.getBalance(id)

    it('keeps a withdrawal across a restart: a new service instance sees it', async () => {
      const uid = await funded('restart@test.com')
      const w = await ngnWalletService.initiateWithdrawal(uid, { amountNgn: 1000, bankAccount })

      const restarted = new NgnWalletService()

      expect((await restarted.getWithdrawal(w.id))?.status).toBe('pending')
      expect((await restarted.getWithdrawalHistory(uid)).entries.map((e) => e.id)).toEqual([w.id])
    })

    it('reserves on initiate, and approving moves it to approved only: nothing is confirmed or released', async () => {
      const uid = await funded('approve@test.com')
      const before = await balanceOf(uid)
      const w = await ngnWalletService.initiateWithdrawal(uid, { amountNgn: 1000, bankAccount })
      const reserved = await balanceOf(uid)

      const approved = await ngnWalletService.approveWithdrawal(w.id, 'admin-1')

      expect(reserved.availableNgn).toBe(before.availableNgn - 1000)
      expect(reserved.heldNgn).toBe(before.heldNgn + 1000)
      expect(approved.status).toBe('approved')
      expect(approved.processedAt).toBeNull()
      expect(await balanceOf(uid)).toEqual(reserved)
    })

    it('approving twice is a no-op and records the first approver', async () => {
      const uid = await funded('twice@test.com')
      const w = await ngnWalletService.initiateWithdrawal(uid, { amountNgn: 1000, bankAccount })

      await ngnWalletService.approveWithdrawal(w.id, 'admin-1')
      await ngnWalletService.approveWithdrawal(w.id, 'admin-2')

      const record = await ngnWithdrawalStore.getById(w.id)
      expect(record?.approvedBy).toBe('admin-1')
    })

    it('rejecting releases the reservation exactly once', async () => {
      const uid = await funded('reject@test.com')
      const before = await balanceOf(uid)
      const w = await ngnWalletService.initiateWithdrawal(uid, { amountNgn: 1000, bankAccount })

      await ngnWalletService.rejectWithdrawal(w.id, 'suspicious')
      await ngnWalletService.rejectWithdrawal(w.id, 'suspicious')

      expect(await balanceOf(uid)).toEqual(before)
      const entries = (await ngnWalletStore.getLedgerEntriesByWalletId((await ngnWalletStore.getWalletByUserId(uid))!.walletId))
        .filter((e) => e.referenceId === w.id)
      expect(entries.map((e) => e.type).sort()).toEqual(['WITHDRAWAL_FAILED', 'WITHDRAWAL_PENDING'])
    })

    it('a rejected withdrawal cannot be approved, and an approved one can still be rejected', async () => {
      const uid = await funded('transitions@test.com')
      const a = await ngnWalletService.initiateWithdrawal(uid, { amountNgn: 1000, bankAccount })
      const b = await ngnWalletService.initiateWithdrawal(uid, { amountNgn: 1000, bankAccount })
      await ngnWalletService.rejectWithdrawal(a.id, 'no')
      await ngnWalletService.approveWithdrawal(b.id, 'admin-1')

      await expect(ngnWalletService.approveWithdrawal(a.id, 'admin-1')).rejects.toMatchObject({ status: 409 })
      expect((await ngnWalletService.rejectWithdrawal(b.id, 'changed my mind')).status).toBe('rejected')
    })

    it('a processing payout that fails releases the funds once; one that confirms keeps them held', async () => {
      const uid = await funded('payout@test.com')
      const start = await balanceOf(uid)
      const ok = await ngnWalletService.initiateWithdrawal(uid, { amountNgn: 1000, bankAccount })
      const bad = await ngnWalletService.initiateWithdrawal(uid, { amountNgn: 2000, bankAccount })
      for (const w of [ok, bad]) {
        await ngnWalletService.approveWithdrawal(w.id, 'admin-1')
        await ngnWalletService.claimForPayout(w.id)
      }

      await ngnWalletService.completePayout(ok.id)
      await ngnWalletService.completePayout(ok.id)
      await ngnWalletService.failPayout(bad.id, 'bank rejected')
      await ngnWalletService.failPayout(bad.id, 'bank rejected')

      const end = await balanceOf(uid)
      // 1000 left the wallet; the failed 2000 came back.
      expect(end.totalNgn).toBe(start.totalNgn - 1000)
      expect(end.availableNgn).toBe(start.availableNgn - 1000)
      expect(end.heldNgn).toBe(start.heldNgn)
    })

    it('claimForPayout succeeds once per approved withdrawal', async () => {
      const uid = await funded('claim@test.com')
      const w = await ngnWalletService.initiateWithdrawal(uid, { amountNgn: 1000, bankAccount })

      expect(await ngnWalletService.claimForPayout(w.id)).toBeNull() // not approved yet
      await ngnWalletService.approveWithdrawal(w.id, 'admin-1')
      const [first, second] = await Promise.all([
        ngnWalletService.claimForPayout(w.id),
        ngnWalletService.claimForPayout(w.id),
      ])

      expect([first, second].filter(Boolean)).toHaveLength(1)
    })

    it('an unknown withdrawal is a 404', async () => {
      await expect(ngnWalletService.approveWithdrawal('wd-missing')).rejects.toBeInstanceOf(AppError)
    })

    describe('GET /withdrawals', () => {
      it('requires authentication and the same permission as approve', async () => {
        await request(app).get('/api/admin/withdrawals').expect(401)

        const plain = await userStore.getOrCreateByEmail('plain@test.com')
        void plain
        const session = await sessionStore.create('plain@test.com', `plain-${Date.now()}`)
        await request(app).get('/api/admin/withdrawals').set('Authorization', `Bearer ${session.token}`).expect(403)
      })

      it('lists every user\'s withdrawals newest first, with the user and approver', async () => {
        const u1 = await funded('l1@test.com')
        const u2 = await funded('l2@test.com')
        const a = await ngnWalletService.initiateWithdrawal(u1, { amountNgn: 1000, bankAccount })
        const b = await ngnWalletService.initiateWithdrawal(u2, { amountNgn: 2000, bankAccount })
        await ngnWalletService.approveWithdrawal(a.id, 'admin-9')

        const res = await request(app)
          .get('/api/admin/withdrawals')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200)

        const items = res.body.data.items
        expect(items.map((i: { id: string }) => i.id)).toEqual([b.id, a.id])
        expect(items[1]).toMatchObject({ userId: u1, status: 'approved', approvedBy: 'admin-9', amountNgn: 1000 })
        expect(res.body.data.nextCursor).toBeNull()
      })

      it('filters by status and paginates', async () => {
        const uid = await funded('page@test.com', 100_000)
        const ids: string[] = []
        for (let i = 0; i < 3; i += 1) {
          ids.push((await ngnWalletService.initiateWithdrawal(uid, { amountNgn: 1000 + i, bankAccount })).id)
        }
        await ngnWalletService.approveWithdrawal(ids[0], 'admin-1')

        const approved = await request(app)
          .get('/api/admin/withdrawals?status=approved')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200)
        expect(approved.body.data.items.map((i: { id: string }) => i.id)).toEqual([ids[0]])

        const p1 = await request(app).get('/api/admin/withdrawals?limit=2').set('Authorization', `Bearer ${authToken}`).expect(200)
        const p2 = await request(app)
          .get(`/api/admin/withdrawals?limit=2&cursor=${p1.body.data.nextCursor}`)
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200)
        expect(p1.body.data.items.map((i: { id: string }) => i.id)).toEqual([ids[2], ids[1]])
        expect(p2.body.data.items.map((i: { id: string }) => i.id)).toEqual([ids[0]])
        expect(p2.body.data.nextCursor).toBeNull()
      })

      it('rejects a bad status or limit', async () => {
        await request(app).get('/api/admin/withdrawals?status=bogus').set('Authorization', `Bearer ${authToken}`).expect(400)
        await request(app).get('/api/admin/withdrawals?limit=0').set('Authorization', `Bearer ${authToken}`).expect(400)
      })
    })
  })
})
