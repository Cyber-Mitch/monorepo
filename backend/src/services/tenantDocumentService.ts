import { fileTypeFromBuffer } from 'file-type'
import { randomUUID } from 'node:crypto'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import {
  uploadFile,
  deleteFile,
  generatePresignedUpload,
  generatePresignedDownload,
  buildTenantDocumentObjectKey,
} from './storageService.js'
import { getTenantDocumentVaultStore } from '../models/tenantDocumentVaultStore.js'
import type { DocumentCategory, TenantDocumentResponse } from '../schemas/tenantDocument.js'
import type {
  ConfirmUploadRequest,
  DocumentDocType,
  UploadUrlRequest,
} from '../schemas/tenantDocumentPresign.js'

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB
const STORAGE_QUOTA = 500 * 1024 * 1024 // 500 MB
/** Download links are short-lived; the page opens them immediately. */
export const DOWNLOAD_TTL_SECONDS = 15 * 60 // 15 minutes

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
])

const MIME_TO_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

/** Where a presigned upload lands on the documents page when no category is given. */
const DOC_TYPE_CATEGORY: Record<DocumentDocType, DocumentCategory> = {
  id_card: 'identity_document',
  passport: 'identity_document',
  employment_letter: 'other',
  bank_statement: 'other',
  utility_bill: 'other',
  proof_of_address: 'other',
}

export interface ListDocumentsOptions {
  category?: DocumentCategory
  dealId?: string
  search?: string
  page: number
  pageSize: number
}

export interface ListDocumentsResult {
  documents: TenantDocumentResponse[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
}

function notFound(): AppError {
  return new AppError(ErrorCode.NOT_FOUND, 404, 'Document not found')
}

export class TenantDocumentService {
  async uploadDocument(
    userId: string,
    fileBuffer: Buffer,
    fileName: string,
    category: DocumentCategory,
    description?: string,
    dealId?: string,
  ): Promise<TenantDocumentResponse> {
    // Validate file size
    if (fileBuffer.length > MAX_FILE_SIZE) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        `File size exceeds 20 MB limit. Your file is ${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB.`,
      )
    }

    // Validate MIME type
    const fileType = await fileTypeFromBuffer(fileBuffer)
    if (!fileType || !ALLOWED_MIME_TYPES.has(fileType.mime)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        'Invalid file type. Only PDF, JPG, and PNG files are allowed.',
      )
    }

    await this.assertWithinQuota(userId, fileBuffer.length)

    // Upload to S3
    const extension = MIME_TO_EXTENSION[fileType.mime]
    const objectKey = `tenant-documents/${userId}/${category}/${randomUUID()}.${extension}`

    await uploadFile(objectKey, fileBuffer, fileType.mime)

    // Create DB record
    return getTenantDocumentVaultStore().create(userId, {
      fileName,
      fileFormat: extension,
      fileSizeBytes: fileBuffer.length,
      storageKey: objectKey,
      category,
      description,
      dealId,
    })
  }

  /** Owner-scoped, paginated list of confirmed documents. */
  async listDocuments(userId: string, options: ListDocumentsOptions): Promise<ListDocumentsResult> {
    const { documents, total } = await getTenantDocumentVaultStore().list(userId, options)
    return {
      documents,
      pagination: {
        page: options.page,
        pageSize: options.pageSize,
        total,
        totalPages: Math.ceil(total / options.pageSize),
      },
    }
  }

  /**
   * Step 1 of the direct-to-storage upload: records a pending document and
   * returns a presigned PUT URL for an object key under the tenant's prefix.
   */
  async createPresignedUpload(
    userId: string,
    request: UploadUrlRequest,
  ): Promise<{ documentId: string; uploadUrl: string; objectKey: string; expiresAt: string }> {
    const contentType = request.contentType.toLowerCase()
    if (!ALLOWED_MIME_TYPES.has(contentType)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        'Invalid file type. Only PDF, JPG, and PNG files are allowed.',
      )
    }

    const objectKey = buildTenantDocumentObjectKey(userId, request.docType, contentType)
    const pending = await getTenantDocumentVaultStore().createPendingUpload(userId, {
      docType: request.docType,
      contentType,
      objectKey,
      category: request.category ?? DOC_TYPE_CATEGORY[request.docType],
      description: request.description,
      dealId: request.dealId,
    })
    const { uploadUrl, expiresAt } = await generatePresignedUpload(objectKey, contentType)

    return { documentId: pending.id, uploadUrl, objectKey, expiresAt }
  }

  /**
   * Step 2: confirms an upload the caller started. Only the caller's own
   * pending object key can be confirmed; size and quota are enforced here.
   */
  async confirmUpload(userId: string, request: ConfirmUploadRequest): Promise<TenantDocumentResponse> {
    const store = getTenantDocumentVaultStore()
    const pending = await store.findPendingByObjectKey(request.objectKey, userId)
    if (!pending) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, 'Pending upload not found')
    }

    const fileSizeBytes = request.fileSizeBytes
    if (!fileSizeBytes) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'fileSizeBytes is required')
    }
    if (fileSizeBytes > MAX_FILE_SIZE) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'File size exceeds 20 MB limit.')
    }
    await this.assertWithinQuota(userId, fileSizeBytes)

    const fileFormat = MIME_TO_EXTENSION[pending.contentType ?? ''] ?? 'pdf'
    const fileName =
      request.fileName ?? request.objectKey.split('/').pop() ?? `document.${fileFormat}`

    const confirmed = await store.confirmUpload(pending.id, userId, {
      fileName,
      fileFormat,
      fileSizeBytes,
    })
    if (!confirmed) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, 'Pending upload not found')
    }
    return confirmed
  }

  async deleteDocument(id: string, userId: string): Promise<void> {
    const store = getTenantDocumentVaultStore()
    const doc = await store.findById(id, userId)
    if (!doc) throw notFound()
    if (doc.readOnly) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        403,
        'This document was provided by your landlord and cannot be deleted.',
      )
    }

    const result = await store.delete(id, userId)
    if (!result.deleted) throw notFound()

    if (result.storageKey) {
      try {
        await deleteFile(result.storageKey)
      } catch (error) {
        // Log but don't fail if S3 deletion fails
        console.error('Failed to delete from S3:', result.storageKey, error)
      }
    }
  }

  async getDownloadUrl(id: string, userId: string): Promise<string> {
    const doc = await getTenantDocumentVaultStore().findById(id, userId)
    if (!doc) throw notFound()

    const { downloadUrl } = await generatePresignedDownload(doc.storageKey, DOWNLOAD_TTL_SECONDS)
    return downloadUrl
  }

  async addLandlordLeaseToVault(
    tenantId: string,
    dealId: string,
    storageKey: string,
    fileName: string,
    fileSizeBytes: number,
  ): Promise<TenantDocumentResponse> {
    // Create a read-only, landlord-uploaded document
    return getTenantDocumentVaultStore().create(tenantId, {
      fileName,
      fileFormat: 'pdf',
      fileSizeBytes,
      storageKey,
      category: 'lease_agreement',
      dealId,
      isLandlordUploaded: true,
      readOnly: true,
    })
  }

  private async assertWithinQuota(userId: string, additionalBytes: number): Promise<void> {
    const usedBytes = await getTenantDocumentVaultStore().getTotalStorageBytes(userId)
    if (usedBytes + additionalBytes > STORAGE_QUOTA) {
      const remainingBytes = STORAGE_QUOTA - usedBytes
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        `Storage quota exceeded. You have ${(remainingBytes / 1024 / 1024).toFixed(2)} MB remaining.`,
      )
    }
  }
}

export const tenantDocumentService = new TenantDocumentService()
