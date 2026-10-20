/**
 * Tenant personal-data export routes — issue #1899. Each caller can only see
 * their own requests; another user's id returns 404.
 *
 *   POST /api/v1/tenant/data-export        request an export (202)
 *   GET  /api/v1/tenant/data-export/:id    status, and a short-lived download URL when ready
 *
 * Limits: one active request per user (409), and one new request per 24 hours (429).
 * Archives expire 7 days after they are ready.
 */

import { Router, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { tenantDataExportStore, type TenantDataExport } from '../models/tenantDataExportStore.js'
import { getScheduler } from '../jobs/scheduler/worker.js'
import {
  EXPORT_RATE_LIMIT_MS,
  TENANT_DATA_EXPORT_JOB_NAME,
  effectiveExportStatus,
} from '../services/tenantDataExportService.js'
import { generatePresignedDownload } from '../services/storageService.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'
import { dataExportIdParamsSchema } from '../schemas/tenantDataExport.js'

const DOWNLOAD_URL_TTL_SECONDS = 300

function requireUser(req: AuthenticatedRequest) {
  if (!req.user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
  }
  return req.user
}

function toDto(record: TenantDataExport, now: Date) {
  return {
    id: record.id,
    status: effectiveExportStatus(record, now),
    requestedAt: record.requestedAt.toISOString(),
    completedAt: record.completedAt ? record.completedAt.toISOString() : null,
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    failureReason: record.failureReason,
  }
}

export function createTenantDataExportRouter(): Router {
  const router = Router()

  router.post(
    '/',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const now = new Date()

        if (await tenantDataExportStore.findActiveByUserId(user.id)) {
          throw new AppError(
            ErrorCode.CONFLICT,
            409,
            'A data export is already in progress for your account',
          )
        }

        const latest = await tenantDataExportStore.findLatestByUserId(user.id)
        if (latest && now.getTime() - latest.requestedAt.getTime() < EXPORT_RATE_LIMIT_MS) {
          const nextAllowedAt = new Date(latest.requestedAt.getTime() + EXPORT_RATE_LIMIT_MS)
          throw new AppError(
            ErrorCode.TOO_MANY_REQUESTS,
            429,
            `You can request one data export every 24 hours. Next request allowed at ${nextAllowedAt.toISOString()}`,
          )
        }

        const record = await tenantDataExportStore.create(user.id)
        try {
          await getScheduler().schedule({
            name: TENANT_DATA_EXPORT_JOB_NAME,
            handler: TENANT_DATA_EXPORT_JOB_NAME,
            payload: { exportId: record.id },
            priority: 5,
            maxRetries: 3,
          })
        } catch (error) {
          await tenantDataExportStore.update(record.id, {
            status: 'failed',
            failureReason: 'The export could not be queued. Please request a new export.',
          })
          throw error
        }

        auditLog('TENANT_DATA_EXPORT_REQUESTED', extractAuditContext(req, 'user'), {
          exportId: record.id,
        })

        res.status(202).json({ success: true, data: toDto(record, now) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/:id',
    authenticateToken,
    validate(dataExportIdParamsSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const now = new Date()
        const record = await tenantDataExportStore.findById(req.params.id)
        if (!record || record.userId !== user.id) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Data export not found')
        }

        const data: Record<string, unknown> = { ...toDto(record, now) }
        if (effectiveExportStatus(record, now) === 'ready' && record.storageKey) {
          const { downloadUrl, expiresAt } = await generatePresignedDownload(
            record.storageKey,
            DOWNLOAD_URL_TTL_SECONDS,
          )
          data.downloadUrl = downloadUrl
          data.downloadUrlExpiresAt = expiresAt

          auditLog('TENANT_DATA_EXPORT_DOWNLOADED', extractAuditContext(req, 'user'), {
            exportId: record.id,
          })
        }

        res.json({ success: true, data })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
