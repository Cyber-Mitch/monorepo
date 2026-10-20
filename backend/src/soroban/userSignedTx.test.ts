import { describe, it, expect } from 'vitest'
import {
  Account,
  Address,
  Keypair,
  nativeToScVal,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { assertSignedInvocation, buildInvokeOperation, type ExpectedInvocation } from './userSignedTx.js'

const PASSPHRASE = 'Test SDF Network ; September 2015'
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 3))
const OTHER_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 4))

const user = Keypair.random()
const stranger = Keypair.random()

const userArg = () => nativeToScVal(new Address(user.publicKey()))
const amountArg = (n: bigint) => nativeToScVal(n, { type: 'i128' })

function expected(over: Partial<ExpectedInvocation> = {}): ExpectedInvocation {
  return {
    contractId: CONTRACT,
    functionName: 'stake',
    args: [userArg(), amountArg(100n)],
    signer: user.publicKey(),
    networkPassphrase: PASSPHRASE,
    label: 'test stake',
    ...over,
  }
}

function build(opts: {
  source?: Keypair
  signWith?: Keypair | null
  contract?: string
  fn?: string
  args?: ReturnType<typeof userArg>[]
  operations?: number
} = {}) {
  const source = opts.source ?? user
  const builder = new TransactionBuilder(new Account(source.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
  for (let i = 0; i < (opts.operations ?? 1); i += 1) {
    builder.addOperation(
      buildInvokeOperation(
        opts.contract ?? CONTRACT,
        opts.fn ?? 'stake',
        opts.args ?? [userArg(), amountArg(100n)],
      ),
    )
  }
  const tx = builder.setTimeout(300).build()
  const signer = opts.signWith === undefined ? source : opts.signWith
  if (signer) tx.sign(signer)
  return tx.toXDR()
}

describe('assertSignedInvocation (#1965, #1972)', () => {
  it('accepts a correctly signed call that matches exactly', () => {
    const tx = assertSignedInvocation(build(), expected())

    expect(tx.source).toBe(user.publicKey())
  })

  it('rejects text that is not a transaction', () => {
    expect(() => assertSignedInvocation('not-xdr', expected())).toThrow(/not a valid transaction envelope/)
  })

  it('rejects an unsigned transaction', () => {
    expect(() => assertSignedInvocation(build({ signWith: null }), expected())).toThrow(
      /transaction is not signed/,
    )
  })

  it('rejects a signature that is not from the expected wallet', () => {
    expect(() => assertSignedInvocation(build({ signWith: stranger }), expected())).toThrow(
      /not signed by the expected wallet/,
    )
  })

  it('rejects a transaction whose source is someone else, even if that someone signed it', () => {
    expect(() => assertSignedInvocation(build({ source: stranger }), expected())).toThrow(
      /source is not the signer/,
    )
  })

  it('rejects a call on a different contract', () => {
    expect(() => assertSignedInvocation(build({ contract: OTHER_CONTRACT }), expected())).toThrow(
      /different contract/,
    )
  })

  it('rejects a different function', () => {
    expect(() => assertSignedInvocation(build({ fn: 'unstake' }), expected())).toThrow(/is not stake/)
  })

  it('rejects different arguments, e.g. another amount', () => {
    const tampered = build({ args: [userArg(), amountArg(999n)] as never })

    expect(() => assertSignedInvocation(tampered, expected())).toThrow(/arguments do not match/)
  })

  it('rejects a different number of arguments', () => {
    expect(() => assertSignedInvocation(build({ args: [userArg()] }), expected())).toThrow(
      /arguments do not match/,
    )
  })

  it('rejects more than one operation', () => {
    expect(() => assertSignedInvocation(build({ operations: 2 }), expected())).toThrow(
      /exactly one operation/,
    )
  })

  it('names the operation in its errors', () => {
    expect(() => assertSignedInvocation('x', expected({ label: 'multisig approve' }))).toThrow(
      /Invalid multisig approve transaction/,
    )
  })
})
