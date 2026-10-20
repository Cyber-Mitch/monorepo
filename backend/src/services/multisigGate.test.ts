import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { executeOrPropose, isMultisigEnabled, describeGateResult } from './multisigGate.js'
import { StubSorobanAdapter } from '../soroban/stub-adapter.js'

const PASSPHRASE = 'Test SDF Network ; September 2015'
const MULTISIG_ID = StrKey.encodeContract(Buffer.alloc(32, 6))
const ESCROW_ID = StrKey.encodeContract(Buffer.alloc(32, 8))
const ACCESS_ID = StrKey.encodeContract(Buffer.alloc(32, 9))
const admin = Keypair.random()

const config = (over = {}) => ({
  rpcUrl: 'x',
  networkPassphrase: PASSPHRASE,
  dealEscrowId: ESCROW_ID,
  contractAccessId: ACCESS_ID,
  adminSecret: admin.secret(),
  ...over,
})

const call = (direct = vi.fn(async () => 'direct-hash')) => ({
  operation: 'propose_assign_role' as const,
  target: 'contractAccess' as const,
  functionName: 'propose_assign_role',
  args: (multisigId: string) => [
    { type: 'address' as const, value: multisigId },
    { type: 'u32' as const, value: 1 },
  ],
  direct,
})

describe('executeOrPropose (#1972)', () => {
  beforeEach(() => {
    StubSorobanAdapter._testOnlyReset()
  })

  it('runs the operation directly when no multisig is configured', async () => {
    const adapter = new StubSorobanAdapter(config())
    const direct = vi.fn(async () => 'direct-hash')

    const result = await executeOrPropose(adapter, call(direct))

    expect(result).toEqual({ mode: 'direct', txHash: 'direct-hash' })
    expect(direct).toHaveBeenCalledTimes(1)
    expect(await adapter.multisigListProposals?.().catch(() => [])).toEqual([])
    expect(describeGateResult(result)).toEqual({})
  })

  it('files a proposal instead of running the operation when a multisig is configured', async () => {
    const adapter = new StubSorobanAdapter(config({ multisigAdminId: MULTISIG_ID }))
    StubSorobanAdapter._testOnlyConfigureMultisig({ signers: [admin.publicKey()], threshold: 1 })
    const direct = vi.fn(async () => 'direct-hash')

    const result = await executeOrPropose(adapter, call(direct))

    expect(direct).not.toHaveBeenCalled()
    expect(result).toMatchObject({ mode: 'multisig', proposalId: 1, multisigContractId: MULTISIG_ID })
    const proposal = await adapter.multisigGetProposal(1)
    expect(proposal).toMatchObject({
      proposer: admin.publicKey(),
      target: ACCESS_ID,
      function: 'propose_assign_role',
      // the admin argument is the multisig contract, which is then the caller
      args: [MULTISIG_ID, 1],
      status: 'pending',
      approvals: [],
    })
    expect(describeGateResult(result)).toMatchObject({
      multisig: { proposalId: 1, contractId: MULTISIG_ID, status: 'pending' },
    })
  })

  it('does not execute anything until signers approve and execute', async () => {
    const adapter = new StubSorobanAdapter(config({ multisigAdminId: MULTISIG_ID }))
    StubSorobanAdapter._testOnlyConfigureMultisig({ signers: [admin.publicKey()], threshold: 1 })

    await executeOrPropose(adapter, call())

    expect(StubSorobanAdapter._testOnlyExecutedMultisigCalls()).toEqual([])
  })

  it('fails clearly when the platform key is not a registered signer', async () => {
    const adapter = new StubSorobanAdapter(config({ multisigAdminId: MULTISIG_ID }))
    StubSorobanAdapter._testOnlyConfigureMultisig({ signers: [Keypair.random().publicKey()], threshold: 1 })
    const direct = vi.fn(async () => 'direct-hash')

    await expect(executeOrPropose(adapter, call(direct))).rejects.toThrow(/Not a signer/)
    expect(direct).not.toHaveBeenCalled()
  })

  it('fails with 503 when the target contract is not configured, rather than running directly', async () => {
    const adapter = new StubSorobanAdapter(
      config({ multisigAdminId: MULTISIG_ID, contractAccessId: undefined }),
    )
    const direct = vi.fn(async () => 'direct-hash')

    await expect(executeOrPropose(adapter, call(direct))).rejects.toMatchObject({ status: 503 })
    expect(direct).not.toHaveBeenCalled()
  })

  it('fails with 501 when the adapter cannot file proposals, rather than running directly', async () => {
    const adapter = { multisigEnabled: () => true, multisigContractId: () => MULTISIG_ID } as never
    const direct = vi.fn(async () => 'direct-hash')

    await expect(executeOrPropose(adapter, call(direct))).rejects.toMatchObject({ status: 501 })
    expect(direct).not.toHaveBeenCalled()
  })

  it('reports whether the adapter has a multisig', () => {
    expect(isMultisigEnabled(new StubSorobanAdapter(config()))).toBe(false)
    expect(isMultisigEnabled(new StubSorobanAdapter(config({ multisigAdminId: MULTISIG_ID })))).toBe(true)
    expect(isMultisigEnabled({} as never)).toBe(false)
  })
})
