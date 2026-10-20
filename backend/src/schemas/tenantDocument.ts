import { z } from 'zod'

export const categorySchema = z.enum([
  'lease_agreement',
  'payment_receipt',
  'identity_document',
  'inspection_report',
  'other',
])

export const uploadBodySchema = z.object({
  category: categorySchema,
  description: z.string().max(500).optional(),
  dealId: z.string().optional(),
})

export const listQuerySchema = z.object({
  category: categorySchema.optional(),
  dealId: z.string().optional(),
  search: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
})

export type UploadBody = z.infer<typeof uploadBodySchema>
export type ListQuery = z.infer<typeof listQuerySchema>
export type DocumentCategory = z.infer<typeof categorySchema>

export interface TenantDocumentRecord {
  id: string
  user_id: string
  file_name: string
  file_format: string
  file_size_bytes: number
  storage_key: string
  category: DocumentCategory
  is_landlord_uploaded: boolean
  read_only: boolean
  deal_id: string | null
  description: string | null
  created_at: string
  updated_at: string
}

export interface TenantDocumentResponse {
  id: string
  userId: string
  fileName: string
  fileFormat: string
  fileSizeBytes: number
  category: DocumentCategory
  description: string | null
  dealId: string | null
  isLandlordUploaded: boolean
  createdAt: string
}
