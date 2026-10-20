/**
 * Helpers for contract calls that need the user's own `require_auth()`.
 *
 * The backend cannot sign those with the admin key, so it builds an unsigned
 * transaction for the wallet to sign (`buildInvokeOperation`) and, before it
 * broadcasts the signed result, checks it with `assertSignedInvocation`: exactly
 * one call, on the expected contract and function, with exactly the expected
 * arguments, from the expected account, carrying a valid signature from it.
 * Anything else is rejected with a 400, so the backend cannot be used to submit
 * arbitrary contract calls on a user's behalf.
 */

import {
  Address,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'

/** The `functionName(...args)` invocation on `contractId`. */
export function buildInvokeOperation(
  contractId: string,
  functionName: string,
  args: xdr.ScVal[],
): xdr.Operation {
  return Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(),
        functionName,
        args,
      }),
    ),
    auth: [],
  })
}

export interface ExpectedInvocation {
  contractId: string
  functionName: string
  /** Exact arguments the call must carry, in order. */
  args: xdr.ScVal[]
  /** The wallet that must be the transaction source and must have signed it. */
  signer: string
  networkPassphrase: string
  /** Names the operation in error messages, e.g. "multisig approval". */
  label: string
}

const argKey = (value: xdr.ScVal) => value.toXDR('base64')

/**
 * Accepts a signed envelope only if it is a single, correctly signed call that
 * matches `expected` exactly. Returns the parsed transaction.
 */
export function assertSignedInvocation(
  signedXdr: string,
  expected: ExpectedInvocation,
): Transaction {
  const reject = (reason: string) =>
    new AppError(ErrorCode.VALIDATION_ERROR, 400, `Invalid ${expected.label} transaction: ${reason}`)

  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>
  try {
    parsed = TransactionBuilder.fromXDR(signedXdr, expected.networkPassphrase)
  } catch {
    throw reject('not a valid transaction envelope')
  }
  if (!(parsed instanceof Transaction)) {
    throw reject('fee-bump transactions are not accepted')
  }

  if (parsed.operations.length !== 1) {
    throw reject('expected exactly one operation')
  }
  const op = parsed.operations[0] as { type: string; func?: xdr.HostFunction; source?: string }
  if (op.type !== 'invokeHostFunction' || !op.func) {
    throw reject('expected an invokeHostFunction operation')
  }
  if (op.source && op.source !== expected.signer) {
    throw reject('operation source is not the signer')
  }

  if (op.func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    throw reject('expected a contract invocation')
  }
  const invoke = op.func.invokeContract()

  if (Address.fromScAddress(invoke.contractAddress()).toString() !== expected.contractId) {
    throw reject('call is on a different contract')
  }
  if (invoke.functionName().toString() !== expected.functionName) {
    throw reject(`call is not ${expected.functionName}`)
  }
  const actual = invoke.args()
  if (
    actual.length !== expected.args.length ||
    actual.some((arg, i) => argKey(arg) !== argKey(expected.args[i]))
  ) {
    throw reject(`${expected.functionName} arguments do not match the request`)
  }

  if (parsed.source !== expected.signer) {
    throw reject('transaction source is not the signer')
  }
  if (parsed.signatures.length === 0) {
    throw reject('transaction is not signed')
  }
  const signerKey = Keypair.fromPublicKey(expected.signer)
  const hash = parsed.hash()
  const signedBySigner = parsed.signatures.some(
    (sig) => sig.hint().equals(signerKey.signatureHint()) && signerKey.verify(hash, sig.signature()),
  )
  if (!signedBySigner) {
    throw reject('transaction is not signed by the expected wallet')
  }

  return parsed
}
