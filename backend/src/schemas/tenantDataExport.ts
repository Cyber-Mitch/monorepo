import { z } from 'zod'

export const dataExportIdParamsSchema = z.object({
  id: z.string().min(1).max(64),
})
