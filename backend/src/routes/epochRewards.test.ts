import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { Keypair, StrKey, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import { createEpochRewardsRouter, createAdminEpochRewardsRouter } from './epochRewards.js'
import { StubSorobanAdapter } from '../soroban/stub-adapter.js'
import { InMemoryLinkedAddressStore } from '../models/linkedAddressStore.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'

const PASSPHRASE = 'Test SDF Network ; September 2015'
const EPOCH_ID = StrKey.encodeContract(Buffer.alloc(32, 5))
const T0 = Math.floor(new Date('2026-10-19T00:00:00Z').getTime() / 1000)
const EPOCH_SECS = 300

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

interface Staker {
  token: string
  wallet: Keypair
}

describe('Epoch rewards routes (#1965)', () => {
  let adapter: StubSorobanAdapter
  let linked: InMemoryLinkedAddressStore
  let app: express.Express
  let adminToken: string
  let tenantToken: string
  let alice: Staker
  let bob: Staker

  const setNow = (secs: number) => vi.setSystemTime(new Date(secs * 1000))

  async function makeStaker(name: string): Promise<Staker> {
    const user = await userStore.getOrCreateByEmail(`${name}-epoch@example.com`)
    const token = `test-token-epoch-${name}`
    await sessionStore.create(user.email, token)
    const wallet = Keypair.random()
    await linked.setLinkedAddress(user.id, wallet.publicKey())
    return { token, wallet }
  }

  /** prepare -> wallet signs -> submit, as a real client would. */
  async function signAndSubmit(
    who: Staker,
    call: 'stake' | 'unstake' | 'claim',
    amount?: string,
  ) {
    const body = amount ? { amount } : {}
    const prepared = await request(app)
      .post(`/api/v1/epoch-rewards/${call}/prepare`)
      .set(auth(who.token))
      .send(body)
    if (prepared.status !== 200) return prepared

    const tx = TransactionBuilder.fromXDR(prepared.body.data.xdr, PASSPHRASE) as Transaction
    tx.sign(who.wallet)
    return request(app)
      .post(`/api/v1/epoch-rewards/${call}/submit`)
      .set(auth(who.token))
      .send({ signedXdr: tx.toXDR(), ...body })
  }

  const fund = (amount: string) =>
    request(app).post('/api/v1/admin/epoch-rewards/fund').set(auth(adminToken)).send({ amount })
  const seal = (body: object = {}) =>
    request(app).post('/api/v1/admin/epoch-rewards/seal').set(auth(adminToken)).send(body)
  const me = (who: Staker) => request(app).get('/api/v1/epoch-rewards/me').set(auth(who.token))

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    setNow(T0)

    StubSorobanAdapter._testOnlyReset()
    StubSorobanAdapter._testOnlyConfigureEpochs(EPOCH_SECS)
    adapter = new StubSorobanAdapter({
      rpcUrl: 'http://localhost:8000',
      networkPassphrase: PASSPHRASE,
      epochRewardsId: EPOCH_ID,
    })
    linked = new InMemoryLinkedAddressStore()
    sessionStore.clear()
    userStore.clear()

    app = express()
    app.use(requestIdMiddleware)
    app.use(express.json())
    app.use('/api/v1/epoch-rewards', createEpochRewardsRouter(adapter, linked))
    app.use('/api/v1/admin/epoch-rewards', createAdminEpochRewardsRouter(adapter))
    app.use(errorHandler)

    alice = await makeStaker('alice')
    bob = await makeStaker('bob')

    // requirePermission falls back to the legacy role when no RBAC database is configured.
    const admin = Object.assign(await userStore.getOrCreateByEmail('epoch-admin@example.com'), {
      role: 'admin',
    })
    adminToken = 'test-token-epoch-admin'
    await sessionStore.create(admin.email, adminToken)

    const tenant = await userStore.getOrCreateByEmail('epoch-tenant@example.com')
    tenantToken = 'test-token-epoch-tenant'
    await sessionStore.create(tenant.email, tenantToken)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('GET /me', () => {
    it('requires authentication and a linked wallet', async () => {
      await request(app).get('/api/v1/epoch-rewards/me').expect(401)
      const res = await request(app).get('/api/v1/epoch-rewards/me').set(auth(tenantToken)).expect(400)
      expect(res.body.error?.message).toMatch(/No linked wallet/)
    })

    it('shows the position of the linked wallet', async () => {
      await signAndSubmit(alice, 'stake', '500').then((r) => expect(r.status).toBe(200))

      const res = await me(alice).expect(200)

      expect(res.body.data).toMatchObject({
        wallet: alice.wallet.publicKey(),
        currentEpoch: 1,
        staked: '500',
        claimable: '0',
        totalStaked: '500',
      })
      expect(res.body.data.epoch).toMatchObject({ epochNumber: 1, sealed: false, endTs: T0 + EPOCH_SECS })
    })
  })

  describe('stake -> fund -> seal -> claim', () => {
    it('runs the whole flow and pays each staker pro-rata, once', async () => {
      expect((await signAndSubmit(alice, 'stake', '100')).status).toBe(200)
      expect((await signAndSubmit(bob, 'stake', '300')).status).toBe(200)
      expect((await fund('4000')).status).toBe(201)

      // Nothing is claimable until the epoch is sealed.
      expect((await me(alice)).body.data.claimable).toBe('0')

      setNow(T0 + EPOCH_SECS)
      const sealed = await seal({ nextEpochDurationSecs: EPOCH_SECS })
      expect(sealed.status).toBe(201)
      expect(sealed.body.data).toMatchObject({ status: 'sealed', epoch: 1 })

      const aliceView = (await me(alice)).body.data
      const bobView = (await me(bob)).body.data
      expect(aliceView.currentEpoch).toBe(2)
      expect(aliceView.claimable).toBe('1000')
      expect(bobView.claimable).toBe('3000')

      const claim = await signAndSubmit(alice, 'claim')
      expect(claim.status).toBe(200)
      expect(claim.body.data.txHash).toMatch(/claim/)
      expect((await me(alice)).body.data.claimable).toBe('0')

      // Claiming again has nothing to pay, and says so at the prepare step.
      const again = await request(app).post('/api/v1/epoch-rewards/claim/prepare').set(auth(alice.token))
      expect(again.status).toBe(400)
      expect(again.body.error.message).toMatch(/Nothing to claim/)
      expect((await me(bob)).body.data.claimable).toBe('3000')
    })

    it('shows a sealed epoch with its frozen figures', async () => {
      await signAndSubmit(alice, 'stake', '100')
      await fund('250')
      setNow(T0 + EPOCH_SECS)
      await seal()

      const res = await request(app)
        .get('/api/v1/epoch-rewards/epochs/1')
        .set(auth(alice.token))
        .expect(200)

      expect(res.body.data).toMatchObject({
        epochNumber: 1,
        sealed: true,
        totalRewards: '250',
        totalStakedAtSeal: '100',
      })
      await request(app).get('/api/v1/epoch-rewards/epochs/9').set(auth(alice.token)).expect(404)
      await request(app).get('/api/v1/epoch-rewards/epochs/0').set(auth(alice.token)).expect(400)
    })
  })

  describe('stake and unstake', () => {
    it('unstakes part of a position', async () => {
      await signAndSubmit(alice, 'stake', '500')

      expect((await signAndSubmit(alice, 'unstake', '200')).status).toBe(200)

      expect((await me(alice)).body.data.staked).toBe('300')
    })

    it('rejects unstaking more than is staked, before building a transaction', async () => {
      await signAndSubmit(alice, 'stake', '100')

      const res = await request(app)
        .post('/api/v1/epoch-rewards/unstake/prepare')
        .set(auth(alice.token))
        .send({ amount: '101' })

      expect(res.status).toBe(400)
      expect(res.body.error.message).toMatch(/more than is staked/)
    })

    it.each(['0', '-5', '1.5', 'abc', ''])('rejects the amount %j', async (amount) => {
      const res = await request(app)
        .post('/api/v1/epoch-rewards/stake/prepare')
        .set(auth(alice.token))
        .send({ amount })

      expect(res.status).toBe(400)
    })
  })

  describe('signed transaction validation', () => {
    async function prepared(who: Staker, amount: string) {
      const res = await request(app)
        .post('/api/v1/epoch-rewards/stake/prepare')
        .set(auth(who.token))
        .send({ amount })
      return TransactionBuilder.fromXDR(res.body.data.xdr, PASSPHRASE) as Transaction
    }

    const submit = (who: Staker, signedXdr: string, amount = '100') =>
      request(app).post('/api/v1/epoch-rewards/stake/submit').set(auth(who.token)).send({ signedXdr, amount })

    it('rejects an unsigned transaction', async () => {
      const tx = await prepared(alice, '100')

      const res = await submit(alice, tx.toXDR())

      expect(res.status).toBe(400)
      expect(res.body.error.message).toMatch(/not signed/)
    })

    it('rejects a transaction signed by someone else', async () => {
      const tx = await prepared(alice, '100')
      tx.sign(bob.wallet)

      const res = await submit(alice, tx.toXDR())

      expect(res.status).toBe(400)
      expect(res.body.error.message).toMatch(/not signed by the expected wallet/)
    })

    it("rejects submitting someone else's transaction as your own", async () => {
      const tx = await prepared(bob, '100')
      tx.sign(bob.wallet)

      const res = await submit(alice, tx.toXDR())

      expect(res.status).toBe(400)
      expect(await adapter.epochRewardsGetStake(alice.wallet.publicKey())).toBe(0n)
    })

    it('rejects an amount that differs from what was signed', async () => {
      const tx = await prepared(alice, '100')
      tx.sign(alice.wallet)

      const res = await submit(alice, tx.toXDR(), '999')

      expect(res.status).toBe(400)
      expect(res.body.error.message).toMatch(/arguments do not match/)
      expect(await adapter.epochRewardsGetStake(alice.wallet.publicKey())).toBe(0n)
    })

    it('rejects a stake transaction submitted as an unstake', async () => {
      const tx = await prepared(alice, '100')
      tx.sign(alice.wallet)

      const res = await request(app)
        .post('/api/v1/epoch-rewards/unstake/submit')
        .set(auth(alice.token))
        .send({ signedXdr: tx.toXDR(), amount: '100' })

      expect(res.status).toBe(400)
      expect(res.body.error.message).toMatch(/is not unstake/)
    })

    it('rejects garbage', async () => {
      const res = await submit(alice, 'AAAA')

      expect(res.status).toBe(400)
      expect(res.body.error.message).toMatch(/not a valid transaction envelope/)
    })
  })

  describe('admin: fund and seal', () => {
    it('require the rewards:manage permission', async () => {
      await request(app).post('/api/v1/admin/epoch-rewards/fund').send({ amount: '1' }).expect(401)
      await request(app)
        .post('/api/v1/admin/epoch-rewards/fund')
        .set(auth(alice.token))
        .send({ amount: '1' })
        .expect(403)
      await request(app).post('/api/v1/admin/epoch-rewards/seal').set(auth(alice.token)).send({}).expect(403)
    })

    it('rejects a bad fund amount', async () => {
      expect((await fund('0')).status).toBe(400)
      expect((await fund('-1')).status).toBe(400)
    })

    it('refuses to seal an epoch that has not ended', async () => {
      setNow(T0 + EPOCH_SECS - 1)

      const res = await seal()

      expect(res.status).toBe(409)
      expect(res.body.error.message).toMatch(/has not ended yet/)
      expect((await request(app).get('/api/v1/epoch-rewards/epochs/1').set(auth(alice.token))).body.data.sealed).toBe(false)
    })

    it('is idempotent: sealing the same epoch again changes nothing', async () => {
      setNow(T0 + EPOCH_SECS)
      const first = await seal({ nextEpochDurationSecs: EPOCH_SECS })
      expect(first.status).toBe(201)

      const second = await seal({ targetEpoch: 1 })

      expect(second.status).toBe(200)
      expect(second.body.data).toEqual({ status: 'already_sealed', epoch: 1 })
      expect(await adapter.epochRewardsCurrentEpoch()).toBe(2)
    })

    it('does not skip ahead: an epoch after the current one cannot be sealed', async () => {
      setNow(T0 + EPOCH_SECS)

      const res = await seal({ targetEpoch: 2 })

      expect(res.status).toBe(409)
      expect(res.body.error.message).toMatch(/sealed in order/)
      expect(await adapter.epochRewardsCurrentEpoch()).toBe(1)
    })
  })

  it('answers 501 when the adapter has no epoch rewards support', async () => {
    const bare = express()
    bare.use(requestIdMiddleware)
    bare.use(express.json())
    bare.use('/api/v1/epoch-rewards', createEpochRewardsRouter({} as never, linked))
    bare.use(errorHandler)

    await request(bare).get('/api/v1/epoch-rewards/me').set(auth(alice.token)).expect(501)
  })
})
