import { z } from 'zod'

export const erasureRequestStatusSchema = z.enum(['pending', 'completed', 'cancelled', 'expired'])

/**
 * POST /api/v1/user/erasure
 * Exactly one fresh login proof is required: an email OTP (from
 * POST /auth/request-otp) or, for wallet-only accounts, a signed challenge
 * (from POST /auth/wallet/challenge).
 */
export const createErasureRequestSchema = z
  .object({
    otp: z.string().length(6).optional(),
    signedChallengeXdr: z.string().min(1).optional(),
  })
  .strict()
  .refine((body) => Boolean(body.otp) !== Boolean(body.signedChallengeXdr), {
    message: 'Provide exactly one of otp or signedChallengeXdr',
  })

export const listErasureRequestsQuerySchema = z.object({
  status: erasureRequestStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export const erasureRequestIdParamsSchema = z.object({
  id: z.string().uuid(),
})

export type CreateErasureRequestBody = z.infer<typeof createErasureRequestSchema>
export type ListErasureRequestsQuery = z.infer<typeof listErasureRequestsQuerySchema>
