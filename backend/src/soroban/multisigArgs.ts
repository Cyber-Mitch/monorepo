import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk'
import type { MultisigArg } from './adapter.js'

/** Encodes a JSON-safe argument as the Soroban value the proposed call will receive. */
export function encodeMultisigArg(arg: MultisigArg): xdr.ScVal {
  switch (arg.type) {
    case 'address':
      return nativeToScVal(Address.fromString(arg.value))
    case 'symbol':
      return nativeToScVal(arg.value, { type: 'symbol' })
    case 'string':
      return nativeToScVal(arg.value, { type: 'string' })
    case 'bool':
      return nativeToScVal(arg.value)
    case 'u32':
    case 'i32':
      return nativeToScVal(arg.value, { type: arg.type })
    case 'u64':
    case 'i64':
    case 'u128':
    case 'i128':
      return nativeToScVal(BigInt(arg.value), { type: arg.type })
  }
}

/** Turns a decoded Soroban value into something `JSON.stringify` accepts. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex')
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]))
  }
  return value
}

/** Decodes proposal arguments (`Vec<Val>`) into JSON-safe values. */
export function decodeProposalArgs(args: readonly xdr.ScVal[]): unknown[] {
  return args.map((arg) => toJsonSafe(scValToNative(arg)))
}
