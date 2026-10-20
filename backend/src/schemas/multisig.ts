import { z } from 'zod'
import { StrKey } from '@stellar/stellar-sdk'

const address = z.string().refine((v) => StrKey.isValidEd25519PublicKey(v) || StrKey.isValidContract(v), {
  message: 'Must be a Stellar account (G...) or contract (C...) address',
})

const decimal = (bits: number, signed: boolean) =>
  z.string().refine(
    (value) => {
      if (!(signed ? /^-?\d+$/ : /^\d+$/).test(value)) return false
      const n = BigInt(value)
      const limit = BigInt(1) << BigInt(signed ? bits - 1 : bits)
      return signed ? n >= -limit && n < limit : n < limit
    },
    { message: `Must be a ${signed ? 'signed' : 'unsigned'} ${bits}-bit integer in decimal` },
  )

/** An argument of the proposed call, typed so it can be encoded for the contract. */
export const multisigArgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('address'), value: address }),
  z.object({ type: z.literal('symbol'), value: z.string().min(1).max(32).regex(/^[A-Za-z0-9_]+$/) }),
  z.object({ type: z.literal('string'), value: z.string().max(1024) }),
  z.object({ type: z.literal('bool'), value: z.boolean() }),
  z.object({ type: z.literal('bytes32'), value: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Must be 64 hex characters') }),
  z.object({ type: z.literal('u32'), value: z.number().int().min(0).max(4_294_967_295) }),
  z.object({ type: z.literal('i32'), value: z.number().int().min(-2_147_483_648).max(2_147_483_647) }),
  z.object({ type: z.literal('u64'), value: decimal(64, false) }),
  z.object({ type: z.literal('i64'), value: decimal(64, true) }),
  z.object({ type: z.literal('u128'), value: decimal(128, false) }),
  z.object({ type: z.literal('i128'), value: decimal(128, true) }),
])

const signedXdr = z.string().min(1).max(20_000)

const functionName = z.string().min(1).max(32).regex(/^[A-Za-z0-9_]+$/, 'Must be a valid contract function name')

export const prepareProposeSchema = z.object({
  target: address,
  function: functionName,
  args: z.array(multisigArgSchema).max(16).default([]),
})

export const proposalIdParamsSchema = z.object({
  id: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
})

export const listProposalsQuerySchema = z.object({
  status: z.enum(['pending', 'executed', 'cancelled', 'expired']).optional(),
  target: address.optional(),
  function: functionName.optional(),
  /** Only pending proposals the caller's wallet has not approved yet. */
  awaitingMySignature: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
})

/**
 * Submitting restates what the signed transaction must contain, so the backend
 * can check the signed XDR against it rather than trusting the envelope.
 */
export const submitMultisigSchema = z.discriminatedUnion('call', [
  z.object({
    call: z.literal('propose'),
    signedXdr,
    target: address,
    function: functionName,
    args: z.array(multisigArgSchema).max(16).default([]),
  }),
  z.object({
    call: z.enum(['approve', 'revoke_approval', 'execute']),
    signedXdr,
    proposalId: z.number().int().min(1),
  }),
])

export type MultisigArgInput = z.infer<typeof multisigArgSchema>
