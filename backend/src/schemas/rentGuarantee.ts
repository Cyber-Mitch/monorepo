import { z } from 'zod'

export const dealIdParamSchema = z.object({
  dealId: z.string().uuid(),
})

export const policyIdParamSchema = z.object({
  id: z.string().uuid(),
})

export const cancelPolicySchema = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
})

export const fileClaimSchema = z.object({
  amountNgn: z.number().positive().max(1_000_000_000),
  reason: z.string().trim().min(10, 'Describe the reason for the claim').max(2000),
})

export type FileClaimRequest = z.infer<typeof fileClaimSchema>
