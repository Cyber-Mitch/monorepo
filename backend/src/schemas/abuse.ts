import { z } from 'zod'

export const listAbuseEventsSchema = z.object({
  type: z.enum(['credential_stuffing', 'scraping', 'deal_spam', 'manual_block']).optional(),
  target: z.string().optional(),
})

export const listAbuseBlocksSchema = z.object({
  targetType: z.enum(['ip', 'user']).optional(),
  type: z.enum(['credential_stuffing', 'scraping', 'deal_spam', 'manual_block']).optional(),
})

export const createManualBlockSchema = z.object({
  target: z.string().min(1, 'Target is required'),
  targetType: z.enum(['ip', 'user']),
  reason: z.string().min(1, 'Reason is required').max(500, 'Reason must be at most 500 characters'),
  expiryHours: z.number().int().min(1).max(8760, 'Expiry must be between 1 and 8760 hours (1 year)'),
})

export type ListAbuseEventsInput = z.infer<typeof listAbuseEventsSchema>
export type ListAbuseBlocksInput = z.infer<typeof listAbuseBlocksSchema>
export type CreateManualBlockInput = z.infer<typeof createManualBlockSchema>
