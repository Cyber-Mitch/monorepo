/**
 * Tenant Document Vault Routes
 * Lists, uploads (presigned), downloads and deletes a tenant's own documents.
 * Every route is authenticated and owner-scoped: another user's document is
 * indistinguishable from a missing one (404).
 */

import { Router, Request, Response, NextFunction } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { listQuerySchema } from "../schemas/tenantDocument.js";
import {
  confirmUploadSchema,
  uploadUrlRequestSchema,
} from "../schemas/tenantDocumentPresign.js";
import {
  DOWNLOAD_TTL_SECONDS,
  tenantDocumentService,
} from "../services/tenantDocumentService.js";
import { AppError } from "../errors/AppError.js";
import { ErrorCode } from "../errors/errorCodes.js";
import { auditLog, extractAuditContext } from "../utils/auditLogger.js";

function requireUserId(req: Request): string {
  const userId = (req as any).user?.userId;
  if (!userId) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, "User not authenticated");
  }
  return userId;
}

export function createTenantDocumentsRouter(): Router {
  const router = Router();

  /**
   * GET /api/v1/tenant/documents
   * Paginated list of the caller's documents, filterable by category,
   * dealId and a free-text search over file name and description.
   */
  router.get(
    "/",
    authenticateToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = requireUserId(req);
        const query = listQuerySchema.parse(req.query);
        const { documents, pagination } =
          await tenantDocumentService.listDocuments(userId, query);
        res.json({ success: true, data: documents, pagination });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * POST /api/v1/tenant/documents/presign
   * Starts a direct-to-storage upload: returns a presigned PUT URL.
   */
  router.post(
    "/presign",
    authenticateToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = requireUserId(req);
        const body = uploadUrlRequestSchema.parse(req.body);
        const result = await tenantDocumentService.createPresignedUpload(userId, body);
        auditLog("DOCUMENT_UPLOAD_URL_ISSUED", extractAuditContext(req, "user"), {
          documentId: result.documentId,
          docType: body.docType,
          contentType: body.contentType,
        });
        res.status(201).json({ success: true, data: result });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * POST /api/v1/tenant/documents
   * Confirms a presigned upload and records its metadata.
   */
  router.post(
    "/",
    authenticateToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = requireUserId(req);
        const body = confirmUploadSchema.parse(req.body);
        const document = await tenantDocumentService.confirmUpload(userId, body);
        auditLog("DOCUMENT_UPLOAD_CONFIRMED", extractAuditContext(req, "user"), {
          documentId: document.id,
          category: document.category,
          fileSizeBytes: document.fileSizeBytes,
        });
        res.status(201).json({ success: true, data: document });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * DELETE /api/v1/tenant/documents/:id
   */
  router.delete(
    "/:id",
    authenticateToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = requireUserId(req);
        await tenantDocumentService.deleteDocument(req.params.id, userId);
        auditLog("DOCUMENT_DELETED", extractAuditContext(req, "user"), {
          documentId: req.params.id,
        });
        res.json({ success: true, data: { documentId: req.params.id, deleted: true } });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * GET /api/v1/tenant/documents/:id/download
   * Short-lived presigned download URL.
   */
  router.get(
    "/:id/download",
    authenticateToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = requireUserId(req);
        const downloadUrl = await tenantDocumentService.getDownloadUrl(req.params.id, userId);
        auditLog("DOCUMENT_DOWNLOAD_URL_ISSUED", extractAuditContext(req, "user"), {
          documentId: req.params.id,
          expiresInSeconds: DOWNLOAD_TTL_SECONDS,
        });
        res.json({
          success: true,
          data: {
            documentId: req.params.id,
            downloadUrl,
            expiresInSeconds: DOWNLOAD_TTL_SECONDS,
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
