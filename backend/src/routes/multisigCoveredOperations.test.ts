import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'
import { createCircuitBreakerRouter } from './circuitBreaker.js'
import { createAdminContractAccessRouter } from './adminContractAccess.js'
import { StubSorobanAdapter } from '../soroban/stub-adapter.js'

vi.mock('../schemas/env.js', () => ({
  env: { MANUAL_ADMIN_SECRET: 'test-secret' },
}))

vi.mock('../utils/auditLogger.js', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
  extractAuditContext: vi.fn(() => ({ userId: 'admin', requestId: 'r', ip: '127.0.0.1', actorType: 'admin', httpMethod: 'POST' })),
}))

const PASSPHRASE = 'Test SDF Network ; September 2015'
const MULTISIG_ID = StrKey.encodeContract(Buffer.alloc(32, 6))
const ESCROW_ID = StrKey.encodeContract(Buffer.alloc(32, 8))
const ACCESS_ID = StrKey.encodeContract(Buffer.alloc(32, 9))
const platformKey = Keypair.random()
const subject = Keypair.random().publicKey()
const DRAIN_HASH = 'ab'.repeat(32)

const secret = { 'x-admin-secret': 'test-secret' }

function build(withMultisig: boolean) {
  StubSorobanAdapter._testOnlyReset()
  const adapter = new StubSorobanAdapter({
    rpcUrl: 'x',
    networkPassphrase: PASSPHRASE,
    dealEscrowId: ESCROW_ID,
    contractAccessId: ACCESS_ID,
    adminSecret: platformKey.secret(),
    multisigAdminId: withMultisig ? MULTISIG_ID : undefined,
  })
  const proposeAssignRole = vi.fn(async () => 'direct-role-hash')
  ;(adapter as unknown as { proposeAssignRole: typeof proposeAssignRole }).proposeAssignRole = proposeAssignRole
  const proposeDrain = vi.spyOn(adapter, 'proposeDrain')
  const executeDrain = vi.spyOn(adapter, 'executeDrain')
  const freeze = vi.spyOn(adapter, 'freeze')
  if (withMultisig) {
    StubSorobanAdapter._testOnlyConfigureMultisig({ signers: [platformKey.publicKey()], threshold: 1 })
  }

  const app = express()
  app.use(requestIdMiddleware)
  app.use(express.json())
  app.use('/cb', createCircuitBreakerRouter(adapter))
  app.use('/ca', createAdminContractAccessRouter(adapter))
  app.use(errorHandler)
  return { app, adapter, proposeAssignRole, proposeDrain, executeDrain, freeze }
}

describe('covered admin operations without a multisig (#1972)', () => {
  let ctx: ReturnType<typeof build>
  beforeEach(() => {
    ctx = build(false)
  })

  it('propose-drain runs directly', async () => {
    const res = await request(ctx.app).post('/cb/propose-drain').set(secret).send({ destination: subject })

    expect(res.status).toBe(200)
    expect(ctx.proposeDrain).toHaveBeenCalledWith(subject)
    expect(res.body.multisig).toBeUndefined()
  })

  it('execute-drain runs directly', async () => {
    const res = await request(ctx.app).post('/cb/execute-drain').set(secret).send({})

    expect(res.status).toBe(200)
    expect(ctx.executeDrain).toHaveBeenCalledTimes(1)
  })

  it('propose-assign-role runs directly', async () => {
    const res = await request(ctx.app).post('/ca/propose-assign-role').set(secret).send({ subject, role: 1 })

    expect(res.status).toBe(200)
    expect(ctx.proposeAssignRole).toHaveBeenCalledWith(subject, 1)
    expect(res.body.txHash).toBe('direct-role-hash')
  })

  it('the contract-access routes respond (they used to hang) and still need the admin secret', async () => {
    await request(ctx.app).post('/ca/propose-assign-role').send({ subject, role: 1 }).expect(403)
    await request(ctx.app)
      .post('/ca/propose-assign-role')
      .set({ 'x-admin-secret': 'wrong' })
      .send({ subject, role: 1 })
      .expect(403)
    expect(ctx.proposeAssignRole).not.toHaveBeenCalled()
  })
})

describe('covered admin operations with a multisig (#1972)', () => {
  let ctx: ReturnType<typeof build>
  beforeEach(() => {
    ctx = build(true)
  })

  it('propose-drain becomes a proposal and does not execute', async () => {
    const res = await request(ctx.app)
      .post('/cb/propose-drain')
      .set(secret)
      .send({ destination: subject, drainHash: DRAIN_HASH })

    expect(res.status).toBe(202)
    expect(ctx.proposeDrain).not.toHaveBeenCalled()
    expect(res.body.multisig).toMatchObject({ proposalId: 1, contractId: MULTISIG_ID, status: 'pending' })
    expect(await ctx.adapter.multisigGetProposal(1)).toMatchObject({
      target: ESCROW_ID,
      function: 'propose_drain',
      args: [MULTISIG_ID, DRAIN_HASH],
      status: 'pending',
    })
    expect(StubSorobanAdapter._testOnlyExecutedMultisigCalls()).toEqual([])
  })

  it('execute-drain becomes a proposal and does not execute', async () => {
    const res = await request(ctx.app).post('/cb/execute-drain').set(secret).send({ drainHash: DRAIN_HASH })

    expect(res.status).toBe(202)
    expect(ctx.executeDrain).not.toHaveBeenCalled()
    expect(await ctx.adapter.multisigGetProposal(1)).toMatchObject({
      target: ESCROW_ID,
      function: 'execute_drain',
      args: [MULTISIG_ID, DRAIN_HASH],
    })
  })

  it('drain proposals need the drain hash the contract expects', async () => {
    const missing = await request(ctx.app).post('/cb/propose-drain').set(secret).send({ destination: subject })
    const badHash = await request(ctx.app)
      .post('/cb/execute-drain')
      .set(secret)
      .send({ drainHash: 'not-hex' })

    expect(missing.status).toBe(400)
    expect(missing.body.error.message).toMatch(/drainHash is required/)
    expect(badHash.status).toBe(400)
    expect(await ctx.adapter.multisigListProposals()).toEqual([])
  })

  it('propose-assign-role becomes a proposal with the multisig as the admin argument', async () => {
    const res = await request(ctx.app).post('/ca/propose-assign-role').set(secret).send({ subject, role: 2 })

    expect(res.status).toBe(202)
    expect(ctx.proposeAssignRole).not.toHaveBeenCalled()
    expect(await ctx.adapter.multisigGetProposal(1)).toMatchObject({
      target: ACCESS_ID,
      function: 'propose_assign_role',
      args: [MULTISIG_ID, subject, 2],
    })
  })

  it('freeze stays immediate: it is the emergency stop', async () => {
    const res = await request(ctx.app).post('/cb/freeze').set(secret).send({})

    expect(res.status).toBe(200)
    expect(ctx.freeze).toHaveBeenCalledTimes(1)
    expect(await ctx.adapter.multisigListProposals()).toEqual([])
  })

  it('still requires the admin secret', async () => {
    await request(ctx.app).post('/cb/propose-drain').send({ destination: subject, drainHash: DRAIN_HASH }).expect(403)
    expect(await ctx.adapter.multisigListProposals()).toEqual([])
  })

  it('fails instead of running directly when the platform key is not a signer', async () => {
    StubSorobanAdapter._testOnlyConfigureMultisig({ signers: [Keypair.random().publicKey()], threshold: 1 })

    const res = await request(ctx.app)
      .post('/cb/propose-drain')
      .set(secret)
      .send({ destination: subject, drainHash: DRAIN_HASH })

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(ctx.proposeDrain).not.toHaveBeenCalled()
  })
})
