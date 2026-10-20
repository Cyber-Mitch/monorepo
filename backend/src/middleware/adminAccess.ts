/**
 * Access control for admin routes: an identified admin with an explicit
 * permission, instead of a header secret shared by everyone.
 *
 *   router.get('/x',  requireAdminAccess('reconciliation', 'view'),   handler)
 *   router.post('/y', requireAdminAccess('circuit_breaker', 'execute', { freshAuth: true }), handler)
 *
 * What it does, in order:
 *
 * 1. Authenticates the bearer token and checks the permission `resource:action`
 *    (`authenticateToken` + `requirePermission`; `super_admin` holds all).
 * 2. With `freshAuth`, also requires that the caller's session was created in
 *    the last `FRESH_AUTH_WINDOW_MS` (5 minutes), i.e. that they signed in
 *    recently. A stale session gets 403 `REAUTH_REQUIRED`: sign in again and
 *    retry. Used for destructive actions (drain, executing a timelock
 *    transaction, assigning a role).
 * 3. For mutating methods, writes an `ADMIN_OPERATION` audit entry once the
 *    response is sent, naming the acting admin and, when the response carries
 *    one, the on-chain `txHash`.
 *
 * Legacy shared secret: during the deprecation window the old `x-admin-secret`
 * header is accepted ONLY when `ALLOW_LEGACY_ADMIN_SECRET=true`. It is off by
 * default, every use logs a warning, and a request that carries a bearer token
 * is always judged on the token. The legacy path is not subject to `freshAuth`
 * (a shared secret has no session); it is attributed as `legacy-secret`.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { authenticateToken, type AuthenticatedRequest } from './auth.js'
import { requirePermission } from './rbac.js'
import { hasValidAdminSecret } from './adminSecret.js'
import { sessionStore } from '../models/authStore.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'
import { logger } from '../utils/logger.js'

/** How recently the caller must have signed in for `freshAuth` actions. */
export const FRESH_AUTH_WINDOW_MS = 5 * 60 * 1000

export type AdminAction = 'view' | 'manage' | 'execute'

export interface AdminAccessOptions {
  /** Require a session created within `FRESH_AUTH_WINDOW_MS`. */
  freshAuth?: boolean
  /** Write an audit entry for mutating methods. Defaults to true; turn off where the handler audits itself. */
  audit?: boolean
}

export interface AdminActor {
  /** The admin's user id, or `legacy-secret` when the shared secret was used. */
  id: string
  via: 'jwt' | 'legacy-secret'
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Read at call time so the flag can change without a restart of the test process. */
export function legacyAdminSecretEnabled(): boolean {
  return process.env.ALLOW_LEGACY_ADMIN_SECRET === 'true'
}

/** The admin behind this request. Only meaningful after `requireAdminAccess` ran. */
export function getAdminActor(req: Request): AdminActor {
  const actor = (req as Request & { adminActor?: AdminActor }).adminActor
  if (actor) return actor
  const user = (req as AuthenticatedRequest).user
  return { id: user?.id ?? 'unknown', via: 'jwt' }
}

/** Runs an express middleware and resolves with the error it passed to `next`, if any. */
function run(mw: RequestHandler, req: Request, res: Response): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false
    const done = (err?: unknown) => {
      if (settled) return
      settled = true
      resolve(err)
    }
    try {
      const out = mw(req, res, done) as unknown
      if (out && typeof (out as Promise<unknown>).catch === 'function') {
        ;(out as Promise<unknown>).catch(done)
      }
    } catch (error) {
      done(error)
    }
  })
}

async function assertFreshSession(req: AuthenticatedRequest): Promise<void> {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null
  const session = token ? await sessionStore.getByToken(token) : undefined
  const issuedAt = session?.createdAt?.getTime()
  if (issuedAt === undefined || Date.now() - issuedAt > FRESH_AUTH_WINDOW_MS) {
    throw new AppError(
      ErrorCode.REAUTH_REQUIRED,
      403,
      'Recent authentication required: sign in again and retry this action',
      { maxAgeSeconds: FRESH_AUTH_WINDOW_MS / 1000 },
    )
  }
}

/** Audits a mutating admin request once its response has been sent. */
function auditWhenDone(req: Request, res: Response, resource: string, action: AdminAction): void {
  let txHash: string | undefined
  const originalJson = res.json.bind(res)
  res.json = (body: unknown) => {
    const candidate =
      (body as { txHash?: unknown } | null)?.txHash ??
      (body as { data?: { txHash?: unknown } } | null)?.data?.txHash
    if (typeof candidate === 'string') txHash = candidate
    return originalJson(body)
  }

  res.on('finish', () => {
    if (res.statusCode >= 400) return
    const actor = getAdminActor(req)
    void auditLog('ADMIN_OPERATION', extractAuditContext(req, 'admin'), {
      resource,
      action,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      adminId: actor.id,
      authVia: actor.via,
      statusCode: res.statusCode,
      ...(txHash ? { txHash } : {}),
    })
  })
}

export function requireAdminAccess(
  resource: string,
  action: AdminAction,
  options: AdminAccessOptions = {},
): RequestHandler {
  const permission = requirePermission(resource, action)
  const audit = options.audit ?? true

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const hasBearer = req.headers.authorization?.startsWith('Bearer ') === true

      if (!hasBearer && req.headers['x-admin-secret'] !== undefined && legacyAdminSecretEnabled()) {
        if (!hasValidAdminSecret(req)) {
          throw new AppError(ErrorCode.FORBIDDEN, 403, 'Invalid admin secret')
        }
        logger.warn('Legacy x-admin-secret used for an admin route; it is deprecated and will be removed', {
          resource,
          action,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          requestId: (req as Request & { requestId?: string }).requestId,
        })
        ;(req as Request & { adminActor?: AdminActor }).adminActor = { id: 'legacy-secret', via: 'legacy-secret' }
      } else {
        const authError = await run(authenticateToken as RequestHandler, req, res)
        if (authError) throw authError
        const permissionError = await run(permission as RequestHandler, req, res)
        if (permissionError) throw permissionError
        if (options.freshAuth) await assertFreshSession(req as AuthenticatedRequest)
        ;(req as Request & { adminActor?: AdminActor }).adminActor = {
          id: (req as AuthenticatedRequest).user!.id,
          via: 'jwt',
        }
      }

      if (audit && MUTATING_METHODS.has(req.method)) auditWhenDone(req, res, resource, action)
      next()
    } catch (error) {
      next(error)
    }
  }
}
