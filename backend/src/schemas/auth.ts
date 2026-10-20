import { z } from 'zod'

export const requestOtpSchema = z.object({
  email: z.string().email(),
})

export const verifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
  referralCode: z.string().length(8).optional(),
})

export const walletChallengeSchema = z.object({
  address: z.string().regex(/^G[A-Z0-9]{55}$/, 'Invalid Stellar public key'),
})

export const walletVerifySchema = z.object({
  address: z.string().regex(/^G[A-Z0-9]{55}$/, 'Invalid Stellar public key'),
  signedChallengeXdr: z.string(),
})

export const sessionIdParamSchema = z.object({
  id: z.string().uuid(),
})

export const revokeSessionsQuerySchema = z.object({
  others: z.enum(['true', 'false']).optional(),
})
