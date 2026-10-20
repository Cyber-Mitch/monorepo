import { z } from 'zod'
import { SUPPORTED_INSPECTOR_SERVICE_AREAS } from '../config/inspectorServiceAreas.js'
import { inspectorUserIdParamSchema } from './propertyInspection.js'

export const inspectorOnboardingSchema = z.object({
  bio: z.string().trim().min(1).max(1000),
  serviceAreas: z
    .array(z.enum(SUPPORTED_INSPECTOR_SERVICE_AREAS))
    .min(1)
    .max(SUPPORTED_INSPECTOR_SERVICE_AREAS.length)
    .refine((areas) => new Set(areas).size === areas.length, {
      message: 'serviceAreas must not contain duplicates',
    }),
})

export const listInspectorsQuerySchema = z.object({
  status: z.enum(['pending', 'verified', 'suspended']).optional(),
})

export { inspectorUserIdParamSchema }

export type InspectorOnboardingRequest = z.infer<typeof inspectorOnboardingSchema>
