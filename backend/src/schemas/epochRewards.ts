import { z } from 'zod'

/** Largest i128 value, the largest amount the contract accepts. */
const I128_MAX = (BigInt(1) << BigInt(127)) - BigInt(1)

/** A positive token amount in base units, as a decimal string (i128 does not fit a JSON number). */
export const tokenAmount = z
  .string()
  .regex(/^[1-9]\d*$/, 'Must be a positive integer in token base units')
  .refine((value) => /^[1-9]\d*$/.test(value) && BigInt(value) <= I128_MAX, {
    message: 'Amount exceeds the maximum token amount',
  })

const signedXdr = z.string().min(1).max(20_000)

export const epochAmountSchema = z.object({ amount: tokenAmount })

export const epochSubmitAmountSchema = z.object({ signedXdr, amount: tokenAmount })

export const epochSubmitClaimSchema = z.object({ signedXdr })

export const epochNumberParamsSchema = z.object({
  n: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
})

export const fundEpochSchema = z.object({ amount: tokenAmount })

/** Both fields default to "the current epoch, and another epoch as long as this one". */
export const sealEpochSchema = z.object({
  targetEpoch: z.number().int().min(1).optional(),
  nextEpochDurationSecs: z.number().int().min(1).max(366 * 24 * 60 * 60).optional(),
})
