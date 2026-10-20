/**
 * Lease Agreement routes
 */

import { Router, Request, Response } from 'express'
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js'
import { leaseAgreementStore } from '../models/leaseAgreementStore.js'
import { leaseSignatureStore } from '../models/leaseSignatureStore.js'
import { LeaseStatus } from '../models/leaseAgreement.js'
import { dealStore } from '../models/dealStore.js'
import {
  generateLeaseDraft,
  buildLeaseTemplateData,
  resolveLeaseParties,
} from '../services/leaseDocumentService.js'
import { listingStore } from '../models/listingStore.js'
import { createESignatureProvider, computeDocumentHash } from '../services/eSignatureService.js'
import { checkDocumentIntegrity } from '../services/leaseIntegrity.js'
import { signatureRequestSchema } from '../schemas/leaseAgreement.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'

const router = Router()
const esignProvider = createESignatureProvider()

/**
 * POST /api/deals/:dealId/lease/generate
 * Generate a lease draft for a deal
 */
router.post(
  '/deals/:dealId/lease/generate',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { dealId } = req.params

      const deal = await dealStore.findById(dealId)
      if (!deal) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
      }

      // Only admin or system can generate leases
      if (req.user?.role !== 'admin' && req.user?.role !== 'landlord') {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only admins or landlords can generate leases')
      }

      // The lease names real people and a real address; never fall back to placeholders.
      if (!deal.listingId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 422, 'Cannot draft the lease: the deal has no listing, so there is no property address')
      }
      const listing = await listingStore.getById(deal.listingId)
      if (!listing?.address?.trim()) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 422, 'Cannot draft the lease: the listing has no property address')
      }
      const parties = await resolveLeaseParties(deal)

      const templateData = buildLeaseTemplateData(deal, listing.address, parties)
      const { leaseId, documentKey, documentHash, templateVersion } = await generateLeaseDraft(
        dealId,
        templateData,
      )

      res.status(201).json({
        success: true,
        data: { leaseId, documentKey, documentHash, templateVersion, status: LeaseStatus.DRAFT },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /api/deals/:dealId/lease/send
 * Send signing requests to both tenant and landlord
 */
router.post(
  '/deals/:dealId/lease/send',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { dealId } = req.params

      const deal = await dealStore.findById(dealId)
      if (!deal) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
      }

      const lease = await leaseAgreementStore.getByDealId(dealId)
      if (!lease) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'No lease agreement found for this deal. Generate one first.')
      }

      if (lease.status !== LeaseStatus.DRAFT) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Lease must be in draft status to send')
      }

      // Create signing request with stub provider
      const parties = await resolveLeaseParties(deal)
      await esignProvider.createSigningRequest(lease.documentKey, lease.documentHash ?? computeDocumentHash(lease.documentKey), [
        { id: deal.tenantId, name: parties.tenantName, email: parties.tenantEmail ?? '', role: 'tenant' },
        { id: deal.landlordId, name: parties.landlordName, email: parties.landlordEmail ?? '', role: 'landlord' },
      ])

      // Update lease status
      await leaseAgreementStore.updateStatus(lease.leaseId, LeaseStatus.PENDING_TENANT_SIGNATURE)

      res.json({
        success: true,
        data: { message: 'Signing requests sent to tenant and landlord' },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /api/deals/:dealId/lease/sign-url
 * Get a signing URL for the authenticated user
 */
router.get(
  '/deals/:dealId/lease/sign-url',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { dealId } = req.params

      const deal = await dealStore.findById(dealId)
      if (!deal) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
      }

      const lease = await leaseAgreementStore.getByDealId(dealId)
      if (!lease) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'No lease agreement found for this deal')
      }

      // Determine which signer the user is
      let signerId: string
      if (req.user?.id === deal.tenantId) {
        signerId = deal.tenantId
      } else if (req.user?.id === deal.landlordId) {
        signerId = deal.landlordId
      } else {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'You are not a party to this lease')
      }

      // Get signing URL from provider
      // In stub mode, we create a new request for each URL request
      const parties = await resolveLeaseParties(deal)
      const signingRequest = await esignProvider.createSigningRequest(lease.documentKey, lease.documentHash ?? computeDocumentHash(lease.documentKey), [
        { id: deal.tenantId, name: parties.tenantName, email: parties.tenantEmail ?? '', role: 'tenant' },
        { id: deal.landlordId, name: parties.landlordName, email: parties.landlordEmail ?? '', role: 'landlord' },
      ])

      const signingUrl = await esignProvider.getSigningUrl(signingRequest.requestId, signerId)

      res.json({
        success: true,
        data: {
          url: signingUrl.url,
          expiresAt: signingUrl.expiresAt,
          signerRole: signerId === deal.tenantId ? 'tenant' : 'landlord',
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /api/deals/:dealId/lease
 * Get the current lease agreement status
 */
router.get(
  '/deals/:dealId/lease',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { dealId } = req.params

      const deal = await dealStore.findById(dealId)
      if (!deal) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
      }

      const lease = await leaseAgreementStore.getByDealId(dealId)
      if (!lease) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'No lease agreement found for this deal')
      }

      res.json({
        success: true,
        data: lease,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /api/deals/:dealId/lease/void
 * Void a lease agreement
 */
router.post(
  '/deals/:dealId/lease/void',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { dealId } = req.params

      const lease = await leaseAgreementStore.getByDealId(dealId)
      if (!lease) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'No lease agreement found for this deal')
      }

      if (lease.status === LeaseStatus.FULLY_SIGNED) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Cannot void a fully signed lease')
      }

      await leaseAgreementStore.void(lease.leaseId)

      res.json({
        success: true,
        data: { message: 'Lease agreement voided' },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /api/deals/:dealId/lease/integrity
 * Re-hash the stored lease document and compare it with the hash recorded when
 * the lease was generated. Deal parties only (#1960).
 */
router.get(
  '/deals/:dealId/lease/integrity',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { dealId } = req.params

      const deal = await dealStore.findById(dealId)
      if (!deal) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
      }

      if (req.user?.id !== deal.tenantId && req.user?.id !== deal.landlordId) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'You are not a party to this lease')
      }

      const lease = await leaseAgreementStore.getByDealId(dealId)
      if (!lease) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'No lease agreement found for this deal')
      }

      const integrity = await checkDocumentIntegrity({
        documentKey: lease.documentKey,
        recordedHash: lease.documentHash,
        lastModified: lease.updatedAt,
      })

      res.json({
        success: true,
        data: {
          documentHash: integrity.documentHash,
          documentVersion: integrity.documentVersion,
          lastModified: integrity.lastModified,
          valid: integrity.valid,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /api/deals/:dealId/lease/sign
 * Record a party's signature against the current document hash. Signing is
 * idempotent per party; the lease becomes fully signed once both parties have
 * signed. Refused when the document integrity check fails or the caller is not
 * a party (#1960).
 */
router.post(
  '/deals/:dealId/lease/sign',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const { dealId } = req.params
      const body = signatureRequestSchema.parse(req.body)

      const deal = await dealStore.findById(dealId)
      if (!deal) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
      }

      const userId = req.user?.id
      let signerRole: 'tenant' | 'landlord'
      if (userId === deal.tenantId) {
        signerRole = 'tenant'
      } else if (userId === deal.landlordId) {
        signerRole = 'landlord'
      } else {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'You are not a party to this lease')
      }

      const lease = await leaseAgreementStore.getByDealId(dealId)
      if (!lease) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'No lease agreement found for this deal')
      }
      if (lease.status === LeaseStatus.VOIDED) {
        throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 409, 'Cannot sign a voided lease')
      }

      const integrity = await checkDocumentIntegrity({
        documentKey: lease.documentKey,
        recordedHash: lease.documentHash,
        lastModified: lease.updatedAt,
      })
      if (!integrity.valid) {
        throw new AppError(
          ErrorCode.CONFLICT,
          409,
          'Document integrity check failed: the lease document has changed since it was generated. Regenerate the lease before signing.',
        )
      }

      const existing = await leaseSignatureStore.findByDealAndRole(dealId, signerRole)
      if (existing) {
        return res.json({
          success: true,
          data: {
            success: true,
            leaseId: lease.leaseId,
            signedAt: existing.signedAt.toISOString(),
            documentHash: existing.documentHash,
            signerRole,
            idempotent: true,
          },
        })
      }

      const signature = await leaseSignatureStore.create({
        dealId,
        leaseId: lease.leaseId,
        signerId: userId as string,
        signerRole,
        signerName: body.signerName,
        signDate: body.signDate,
        documentHash: integrity.documentHash,
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      })

      if (signerRole === 'tenant') {
        await leaseAgreementStore.markTenantSigned(lease.leaseId, signature.signatureId)
      } else {
        await leaseAgreementStore.markLandlordSigned(lease.leaseId, signature.signatureId)
      }

      const signatures = await leaseSignatureStore.listByDealId(dealId)
      const hasTenant = signatures.some((s) => s.signerRole === 'tenant')
      const hasLandlord = signatures.some((s) => s.signerRole === 'landlord')
      const finalStatus =
        hasTenant && hasLandlord
          ? LeaseStatus.FULLY_SIGNED
          : hasTenant
            ? LeaseStatus.PENDING_LANDLORD_SIGNATURE
            : LeaseStatus.PENDING_TENANT_SIGNATURE
      await leaseAgreementStore.updateStatus(lease.leaseId, finalStatus)

      auditLog('LEASE_SIGNED', extractAuditContext(req, 'user'), {
        dealId,
        leaseId: lease.leaseId,
        signerRole,
        signatureId: signature.signatureId,
        documentHash: signature.documentHash,
      })

      res.json({
        success: true,
        data: {
          success: true,
          leaseId: lease.leaseId,
          signedAt: signature.signedAt.toISOString(),
          documentHash: signature.documentHash,
          signerRole,
          status: finalStatus,
        },
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'ZodError') {
        return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
      }
      next(error)
    }
  },
)

/**
 * POST /api/webhooks/esignature
 * Webhook endpoint for e-signature events
 */
router.post(
  '/webhooks/esignature',
  async (req: Request, res: Response, next) => {
    try {
      const result = await esignProvider.handleWebhook(req.body)

      // Find the lease by deal ID (from the request)
      // In production, the webhook would include the lease/deal reference
      // For now, we just acknowledge the webhook

      res.json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /api/webhooks/esignature/stub
 * Stub webhook for local development - simulates signing
 */
router.post(
  '/webhooks/esignature/stub',
  async (req: Request, res: Response, next) => {
    try {
      const { token, signer, requestId } = req.query as {
        token: string
        signer: string
        requestId: string
      }

      if (!token || !signer || !requestId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Missing required query params: token, signer, requestId')
      }

      const result = await esignProvider.handleWebhook({ token, signer, requestId })

      res.json({
        success: true,
        data: {
          message: `Signature recorded for ${signer}`,
          ...result,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

export function createLeaseAgreementsRouter(): Router {
  return router
}
