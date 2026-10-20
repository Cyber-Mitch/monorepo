import { z } from 'zod'
import { categorySchema } from './tenantDocument.js'

export const documentDocTypeSchema = z.enum([
  'id_card',
  'passport',
  'employment_letter',
  'bank_statement',
  'utility_bill',
  'proof_of_address',
])

export const uploadUrlRequestSchema = z.object({
  docType: documentDocTypeSchema,
  contentType: z.string().min(1).max(128),
  /** Vault category shown on the documents page; derived from docType when omitted. */
  category: categorySchema.optional(),
  description: z.string().max(500).optional(),
  dealId: z.string().max(128).optional(),
})

export const confirmUploadSchema = z.object({
  objectKey: z.string().min(1).max(512),
  fileName: z.string().min(1).max(255).optional(),
  fileSizeBytes: z.number().int().positive().max(25 * 1024 * 1024).optional(),
})

export type DocumentDocType = z.infer<typeof documentDocTypeSchema>
export type UploadUrlRequest = z.infer<typeof uploadUrlRequestSchema>
export type ConfirmUploadRequest = z.infer<typeof confirmUploadSchema>
