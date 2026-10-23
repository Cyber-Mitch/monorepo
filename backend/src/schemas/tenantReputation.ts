/**
 * Zod schemas for the tenant reputation admin endpoints — issue #1980.
 */

import { z } from 'zod'

/** Path parameter for admin endpoints that operate on a single tenant. */
export const tenantIdParamSchema = z.object({
  tenantId: z.string().min(1, 'tenantId is required'),
})

/** Query parameters for listing tenant reputation scores. */
export const listReputationQuerySchema = z.object({
  limit:  z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export type TenantIdParam         = z.infer<typeof tenantIdParamSchema>
export type ListReputationQuery   = z.infer<typeof listReputationQuerySchema>
