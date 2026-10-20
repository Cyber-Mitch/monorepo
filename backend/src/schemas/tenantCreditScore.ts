import { z } from 'zod'

export const creditScoreHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
})

export const creditScoreUserIdParamsSchema = z.object({
  userId: z.string().min(1).max(128),
})

export type CreditScoreHistoryQuery = z.infer<typeof creditScoreHistoryQuerySchema>
