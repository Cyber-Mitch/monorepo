import { z } from 'zod'
import { PARTNER_APPLICATION_STATUSES } from '../models/partnerLandlordApplicationStore.js'

// +234 / 234 / 0 prefix, then a mobile network digit (7/8/9) and 9 more digits
const NIGERIAN_PHONE = /^(?:\+?234|0)[789][01]\d{8}$/

export const createPartnerLandlordApplicationSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name must be at least 2 characters').max(100),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .refine((v) => NIGERIAN_PHONE.test(v), 'Enter a valid Nigerian phone number')
    .transform((v) => `+234${v.replace(/^(?:\+?234|0)/, '')}`),
  email: z.string().trim().toLowerCase().email('Invalid email address').max(254),
  propertyCount: z.number().int('Property count must be a whole number').min(1).max(10000),
  propertyLocations: z.string().trim().max(1000).default(''),
})

export type CreatePartnerLandlordApplicationRequest = z.infer<
  typeof createPartnerLandlordApplicationSchema
>

export const listPartnerApplicationsSchema = z.object({
  status: z.enum(PARTNER_APPLICATION_STATUSES).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})

export const partnerApplicationIdParamSchema = z.object({
  id: z.string().min(1).max(64),
})

export const updatePartnerApplicationSchema = z
  .object({
    status: z.enum(PARTNER_APPLICATION_STATUSES).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.status !== undefined || v.notes !== undefined, {
    message: 'Provide status and/or notes',
  })
