import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { Keypair, StrKey, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import { createMultisigAdminRouter } from './multisigAdmin.js'
import { StubSorobanAdapter } from '../soroban/stub-adapter.js'
import { InMemoryLinkedAddressStore } from '../models/linkedAddressStore.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'

const PASSPHRASE = 'Test SDF Network ; September 2015'
const MULTISIG_ID = StrKey.encodeContract(Buffer.alloc(32, 6))
const ESCROW_ID = StrKey.encodeContract(Buffer.alloc(32, 8))
const T0 = Math.floor(new Date('2026-10-20T00:00:00Z').getTime() / 1000)

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

interface Signer {
  token: string
  wallet: Keypair
}

describe('Multisig admin routes (#1972)', () => {
  let adapter: StubSorobanAdapter
  let linked: InMemoryLinkedAddressStore
  let app: express.Express
  let alice: Signer
  let bob: Signer
  let carol: Signer
  let outsider: Signer
  let noWallet: string

  async function makeUser(name: string, role: 'admin' | 'tenant' = 'admin', withWallet = true): Promise<Signer> {
    // requirePermission falls back to the legacy role when no RBAC database is configured.
    const user = Object.assign(await userStore.getOrCreateByEmail(`${name}-msig@example.com`), { role })
    const token = `test-token-msig-${name}`
    await sessionStore.create(user.email, token)
    const wallet = Keypair.random()
    if (withWallet) await linked.setLinkedAddress(user.id, wallet.publicKey())
    return { token, wallet }
  }

  /** prepare -> wallet signs -> submit, as the admin UI would. */
  async function signAndSubmit(
    who: Signer,
    prepare: { path: string; body?: object },
    submit: object,
  ) {
    const prepared = await request(app)
      .post(`/api/v1/admin/multisig/${prepare.path}`)
      .set(auth(who.token))
      .send(prepare.body ?? {})
    if (prepared.status !== 200) return prepared
    const tx = TransactionBuilder.fromXDR(prepared.body.data.xdr, PASSPHRASE) as Transaction
    tx.sign(who.wallet)
    return request(app)
      .post('/api/v1/admin/multisig/submit')
      .set(auth(who.token))
      .send({ signedXdr: tx.toXDR(), ...submit })
  }

  const propose = (who: Signer) =>
    signAndSubmit(
      who,
      {
        path: 'propose/prepare',
        body: { target: ESCROW_ID, function: 'set_recovery_delay', args: [{ type: 'u64', value: '86400' }] },
      },
      {
        call: 'propose',
        target: ESCROW_ID,
        function: 'set_recovery_delay',
        args: [{ type: 'u64', value: '86400' }],
      },
    )
  const approve = (who: Signer, id: number) =>
    signAndSubmit(who, { path: `${id}/approve/prepare` }, { call: 'approve', proposalId: id })
  const revoke = (who: Signer, id: number) =>
    signAndSubmit(who, { path: `${id}/revoke/prepare` }, { call: 'revoke_approval', proposalId: id })
  const execute = (who: Signer, id: number) =>
    signAndSubmit(who, { path: `${id}/execute/prepare` }, { call: 'execute', proposalId: id })
  const get = (who: Signer, path = '') =>
    request(app).get(`/api/v1/admin/multisig${path}`).set(auth(who.token))

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(T0 * 1000))

    StubSorobanAdapter._testOnlyReset()
    adapter = new StubSorobanAdapter({
      rpcUrl: 'http://localhost:8000',
      networkPassphrase: PASSPHRASE,
      multisigAdminId: MULTISIG_ID,
      dealEscrowId: ESCROW_ID,
    })
    linked = new InMemoryLinkedAddressStore()
    sessionStore.clear()
    userStore.clear()

    app = express()
    app.use(requestIdMiddleware)
    app.use(express.json())
    app.use('/api/v1/admin/multisig', createMultisigAdminRouter(adapter, linked))
    app.use(errorHandler)

    alice = await makeUser('alice')
    bob = await makeUser('bob')
    carol = await makeUser('carol')
    outsider = await makeUser('outsider')
    noWallet = (await makeUser('nowallet', 'admin', false)).token
    StubSorobanAdapter._testOnlyConfigureMultisig({
      signers: [alice.wallet.publicKey(), bob.wallet.publicKey(), carol.wallet.publicKey()],
      threshold: 2,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('access control', () => {
    it('requires authentication', async () => {
      await request(app).get('/api/v1/admin/multisig').expect(401)
      await request(app).post('/api/v1/admin/multisig/submit').send({}).expect(401)
    })

    it('requires the multisig:sign permission', async () => {
      const tenant = await makeUser('tenant', 'tenant')

      await get(tenant).expect(403)
      await request(app).post('/api/v1/admin/multisig/propose/prepare').set(auth(tenant.token)).send({}).expect(403)
    })

    it('answers 501 when no multisig is configured', async () => {
      const bare = new StubSorobanAdapter({ rpcUrl: 'x', networkPassphrase: PASSPHRASE })
      const unconfigured = express()
      unconfigured.use(requestIdMiddleware)
      unconfigured.use(express.json())
      unconfigured.use('/m', createMultisigAdminRouter(bare, linked))
      unconfigured.use(errorHandler)

      const res = await request(unconfigured).get('/m').set(auth(alice.token))

      expect(res.status).toBe(501)
      expect(res.body.error.message).toMatch(/MULTISIG_ADMIN_ID/)
    })
  })

  describe('config', () => {
    it('shows the signers and threshold', async () => {
      const res = await get(alice, '/config').expect(200)

      expect(res.body.data).toMatchObject({
        contractId: MULTISIG_ID,
        threshold: 2,
        signers: [alice.wallet.publicKey(), bob.wallet.publicKey(), carol.wallet.publicKey()],
      })
    })
  })

  describe('propose -> approve x M -> execute', () => {
    it('runs the whole workflow', async () => {
      const proposed = await propose(alice)
      expect(proposed.status).toBe(200)
      expect(proposed.body.data.call).toBe('propose')

      // One approval is not enough to execute.
      expect((await approve(alice, 1)).status).toBe(200)
      const early = await request(app)
        .post('/api/v1/admin/multisig/1/execute/prepare')
        .set(auth(alice.token))
        .send({})
      expect(early.status).toBe(409)
      expect(early.body.error.message).toMatch(/threshold not reached \(1 of 2\)/)

      expect((await approve(bob, 1)).status).toBe(200)
      const ready = (await get(alice, '/1').expect(200)).body.data
      expect(ready).toMatchObject({ status: 'pending', approvalCount: 2, threshold: 2, ready: true })

      expect((await execute(carol, 1)).status).toBe(200)

      const done = (await get(alice, '/1').expect(200)).body.data
      expect(done.status).toBe('executed')
      expect(StubSorobanAdapter._testOnlyExecutedMultisigCalls()).toEqual([
        {
          proposalId: 1,
          target: ESCROW_ID,
          functionName: 'set_recovery_delay',
          args: [{ type: 'u64', value: '86400' }],
        },
      ])
    })

    it('shows the decoded target, function and arguments', async () => {
      await propose(alice)

      const res = await get(bob, '/1').expect(200)

      expect(res.body.data).toMatchObject({
        id: 1,
        status: 'pending',
        proposer: alice.wallet.publicKey(),
        target: ESCROW_ID,
        function: 'set_recovery_delay',
        args: ['86400'],
        approvals: [],
        approvedByMe: false,
      })
    })

    it('lets a signer withdraw an approval, which then blocks execution again', async () => {
      await propose(alice)
      await approve(alice, 1)
      await approve(bob, 1)
      expect((await revoke(bob, 1)).status).toBe(200)

      const res = await request(app)
        .post('/api/v1/admin/multisig/1/execute/prepare')
        .set(auth(alice.token))
        .send({})

      expect(res.status).toBe(409)
      expect((await get(bob, '/1')).body.data.approvedByMe).toBe(false)
    })

    it('rejects approving twice, and revoking without having approved', async () => {
      await propose(alice)
      await approve(alice, 1)

      const twice = await request(app).post('/api/v1/admin/multisig/1/approve/prepare').set(auth(alice.token)).send({})
      const notApproved = await request(app).post('/api/v1/admin/multisig/1/revoke/prepare').set(auth(bob.token)).send({})

      expect(twice.status).toBe(409)
      expect(twice.body.error.message).toMatch(/already approved/)
      expect(notApproved.status).toBe(409)
    })

    it('does not touch an executed proposal again', async () => {
      await propose(alice)
      await approve(alice, 1)
      await approve(bob, 1)
      await execute(alice, 1)

      const res = await request(app).post('/api/v1/admin/multisig/1/approve/prepare').set(auth(carol.token)).send({})

      expect(res.status).toBe(409)
      expect(res.body.error.message).toMatch(/executed, not pending/)
    })

    it('returns 404 for an unknown proposal', async () => {
      await get(alice, '/42').expect(404)
      await request(app).post('/api/v1/admin/multisig/42/approve/prepare').set(auth(alice.token)).send({}).expect(404)
      await get(alice, '/0').expect(400)
    })
  })

  describe('only signers may act', () => {
    it('refuses a non-signer wallet for every prepare call and for submit', async () => {
      await propose(alice)

      for (const path of ['1/approve/prepare', '1/revoke/prepare', '1/execute/prepare']) {
        const res = await request(app).post(`/api/v1/admin/multisig/${path}`).set(auth(outsider.token)).send({})
        expect(res.status).toBe(403)
        expect(res.body.error.message).toMatch(/not a signer/)
      }
      const prop = await request(app)
        .post('/api/v1/admin/multisig/propose/prepare')
        .set(auth(outsider.token))
        .send({ target: ESCROW_ID, function: 'freeze', args: [] })
      expect(prop.status).toBe(403)
      const submit = await request(app)
        .post('/api/v1/admin/multisig/submit')
        .set(auth(outsider.token))
        .send({ signedXdr: 'x', call: 'approve', proposalId: 1 })
      expect(submit.status).toBe(403)
    })

    it('needs a linked wallet to prepare', async () => {
      const res = await request(app)
        .post('/api/v1/admin/multisig/1/approve/prepare')
        .set(auth(noWallet))
        .send({})

      expect(res.status).toBe(400)
      expect(res.body.error.message).toMatch(/No linked wallet/)
    })
  })

  describe('signed XDR is validated before submission', () => {
    async function prepared(who: Signer, id: number) {
      const res = await request(app)
        .post(`/api/v1/admin/multisig/${id}/approve/prepare`)
        .set(auth(who.token))
        .send({})
      return TransactionBuilder.fromXDR(res.body.data.xdr, PASSPHRASE) as Transaction
    }
    const submit = (who: Signer, body: object) =>
      request(app).post('/api/v1/admin/multisig/submit').set(auth(who.token)).send(body)

    beforeEach(async () => {
      await propose(alice)
      await propose(alice)
    })

    it('rejects an unsigned transaction', async () => {
      const tx = await prepared(alice, 1)

      const res = await submit(alice, { signedXdr: tx.toXDR(), call: 'approve', proposalId: 1 })

      expect(res.status).toBe(400)
      expect(res.body.error.message).toMatch(/not signed/)
      expect((await get(alice, '/1')).body.data.approvals).toEqual([])
    })

    it('rejects a transaction signed by a different wallet', async () => {
      const tx = await prepared(alice, 1)
      tx.sign(bob.wallet)

      const res = await submit(alice, { signedXdr: tx.toXDR(), call: 'approve', proposalId: 1 })

      expect(res.status).toBe(400)
      expect(res.body.error.message).toMatch(/not signed by the expected wallet/)
    })

    it('rejects a transaction for a different proposal than the one named', async () => {
      const tx = await prepared(alice, 1)
      tx.sign(alice.wallet)

      const res = await submit(alice, { signedXdr: tx.toXDR(), call: 'approve', proposalId: 2 })

      expect(res.status).toBe(400)
      expect(res.body.error.message).toMatch(/arguments do not match/)
      expect((await get(alice, '/2')).body.data.approvals).toEqual([])
    })

    it('rejects an approve transaction submitted as an execute', async () => {
      const tx = await prepared(alice, 1)
      tx.sign(alice.wallet)

      const res = await submit(alice, { signedXdr: tx.toXDR(), call: 'execute', proposalId: 1 })

      expect(res.status).toBe(400)
      expect(res.body.error.message).toMatch(/is not execute/)
    })

    it('rejects a propose whose target or arguments differ from the signed ones', async () => {
      const prep = await request(app)
        .post('/api/v1/admin/multisig/propose/prepare')
        .set(auth(alice.token))
        .send({ target: ESCROW_ID, function: 'set_recovery_delay', args: [{ type: 'u64', value: '1' }] })
      const tx = TransactionBuilder.fromXDR(prep.body.data.xdr, PASSPHRASE) as Transaction
      tx.sign(alice.wallet)

      const res = await submit(alice, {
        signedXdr: tx.toXDR(),
        call: 'propose',
        target: ESCROW_ID,
        function: 'set_recovery_delay',
        args: [{ type: 'u64', value: '999999' }],
      })

      expect(res.status).toBe(400)
      expect(res.body.error.message).toMatch(/arguments do not match/)
    })

    it('rejects garbage and malformed bodies', async () => {
      expect((await submit(alice, { signedXdr: 'AAAA', call: 'approve', proposalId: 1 })).status).toBe(400)
      expect((await submit(alice, { call: 'approve', proposalId: 1 })).status).toBe(400)
      expect((await submit(alice, { signedXdr: 'x', call: 'cancel', proposalId: 1 })).status).toBe(400)
      expect((await submit(alice, { signedXdr: 'x', call: 'approve' })).status).toBe(400)
    })
  })

  describe('listing and filtering', () => {
    beforeEach(async () => {
      await propose(alice) // 1: approved by alice and executed below
      await signAndSubmit(
        bob,
        { path: 'propose/prepare', body: { target: MULTISIG_ID, function: 'change_threshold', args: [{ type: 'u32', value: 3 }] } },
        { call: 'propose', target: MULTISIG_ID, function: 'change_threshold', args: [{ type: 'u32', value: 3 }] },
      ) // 2
      await approve(alice, 1)
      await approve(bob, 1)
      await execute(alice, 1)
      await approve(alice, 2)
    })

    it('lists newest first with approval counts and the threshold', async () => {
      const res = await get(alice).expect(200)

      expect(res.body.data.threshold).toBe(2)
      expect(res.body.data.proposals.map((p: { id: number }) => p.id)).toEqual([2, 1])
      expect(res.body.data.proposals[0]).toMatchObject({ id: 2, approvalCount: 1, ready: false, approvedByMe: true })
    })

    it('filters by status', async () => {
      const pending = await get(alice, '?status=pending').expect(200)
      const executed = await get(alice, '?status=executed').expect(200)

      expect(pending.body.data.proposals.map((p: { id: number }) => p.id)).toEqual([2])
      expect(executed.body.data.proposals.map((p: { id: number }) => p.id)).toEqual([1])
    })

    it('filters by target and function', async () => {
      const byTarget = await get(alice, `?target=${MULTISIG_ID}`).expect(200)
      const byFunction = await get(alice, '?function=set_recovery_delay').expect(200)

      expect(byTarget.body.data.proposals.map((p: { id: number }) => p.id)).toEqual([2])
      expect(byFunction.body.data.proposals.map((p: { id: number }) => p.id)).toEqual([1])
    })

    it('lists only what is still waiting for my signature', async () => {
      const aliceView = await get(alice, '?awaitingMySignature=true').expect(200)
      const bobView = await get(bob, '?awaitingMySignature=true').expect(200)

      expect(aliceView.body.data.proposals).toEqual([]) // she approved the only pending one
      expect(bobView.body.data.proposals.map((p: { id: number }) => p.id)).toEqual([2])
    })

    it('rejects an unknown status filter, and awaitingMySignature without a wallet', async () => {
      await get(alice, '?status=bogus').expect(400)
      await request(app)
        .get('/api/v1/admin/multisig?awaitingMySignature=true')
        .set(auth(noWallet))
        .expect(400)
    })
  })

  describe('prepare validation', () => {
    it.each([
      ['a bad target', { target: 'nope', function: 'f', args: [] }],
      ['a bad function name', { target: ESCROW_ID, function: 'not valid!', args: [] }],
      ['an unknown arg type', { target: ESCROW_ID, function: 'f', args: [{ type: 'float', value: 1 }] }],
      ['an out-of-range u32', { target: ESCROW_ID, function: 'f', args: [{ type: 'u32', value: -1 }] }],
      ['a non-numeric u64', { target: ESCROW_ID, function: 'f', args: [{ type: 'u64', value: 'abc' }] }],
      ['a bad bytes32', { target: ESCROW_ID, function: 'f', args: [{ type: 'bytes32', value: 'abcd' }] }],
    ])('rejects %s', async (_label, body) => {
      const res = await request(app)
        .post('/api/v1/admin/multisig/propose/prepare')
        .set(auth(alice.token))
        .send(body)

      expect(res.status).toBe(400)
    })
  })
})
