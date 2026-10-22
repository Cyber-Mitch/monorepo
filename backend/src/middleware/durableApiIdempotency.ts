import type { Request, Response, NextFunction } from 'express'
import { ErrorCode } from '../errors/errorCodes.js'
import type { ErrorResponse } from '../errors/errorCodes.js'
import { durableIdempotencyService } from '../services/durableIdempotencyService.js'
import { IDEMPOTENCY_DOCS_URL, UUID_RE } from './idempotency.js'

export interface DurableApiIdempotencyOptions {
  /**
   * Whether a missing key is rejected with 400. Defaults to `true` outside the
   * test environment, matching the in-memory `idempotency()` middleware.
   */
  requireKey?: boolean
}

/**
 * Per-user, per-route scope, so one key can be reused across users and routes without colliding.
 * Unauthenticated callers are scoped by IP, since no identity is available to trust.
 */
function scopeFor(req: Request): string {
  const userId = (req as { user?: { id?: string } }).user?.id ?? `ip:${req.ip}`
  const route = `${req.baseUrl}${typeof req.route?.path === 'string' ? req.route.path : req.path}`
  return `api:${userId}:${req.method}:${route}`
}

/**
 * Idempotency for routes that move money (payments, deposits, staking, deals,
 * rent guarantee). Same `Idempotency-Key` contract as `idempotency()`, but the
 * record lives in `api_idempotency` (Postgres when `DATABASE_URL` is set), so a
 * retry that lands on another instance, or after a restart, replays the first
 * response instead of executing again.
 *
 * - First request with a key: runs; its response is stored before it is sent.
 * - Same key, same body, finished: the stored response is replayed
 *   (`x-idempotent-replay: true`).
 * - Same key, same body, still running: 409 `REQUEST_IN_FLIGHT`.
 * - Same key, different body: 409 `CONFLICT`.
 * - A 5xx response, or a request that is dropped, releases the key so the
 *   client can retry; other responses (including 4xx) are stored and replayed.
 */
export function durableApiIdempotency(options: DurableApiIdempotencyOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requireKey = options.requireKey ?? process.env.NODE_ENV !== 'test'
      const header = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key']

      if (typeof header !== 'string' || header.trim() === '') {
        if (!requireKey) return next()
        const body: ErrorResponse = {
          error: {
            code: ErrorCode.VALIDATION_ERROR,
            message:
              'Missing Idempotency-Key header. Mutating payment and booking requests require a UUID idempotency key.',
            details: { documentationUrl: IDEMPOTENCY_DOCS_URL },
          },
        }
        return void res.status(400).json(body)
      }

      const key = header.trim()
      const isLegacyHeader = req.headers['idempotency-key'] === undefined
      if (!isLegacyHeader && !UUID_RE.test(key)) {
        const body: ErrorResponse = {
          error: {
            code: ErrorCode.VALIDATION_ERROR,
            message: 'Idempotency-Key must be a valid UUID.',
            details: { documentationUrl: IDEMPOTENCY_DOCS_URL },
          },
        }
        return void res.status(400).json(body)
      }
      if (key.length > 256) {
        const body: ErrorResponse = {
          error: {
            code: ErrorCode.VALIDATION_ERROR,
            message: 'Idempotency key must not exceed 256 characters.',
          },
        }
        return void res.status(400).json(body)
      }

      const scope = scopeFor(req)
      const started = await durableIdempotencyService.start({
        scope,
        idempotencyKey: key,
        requestBodyHash: durableIdempotencyService.payloadHash(req.body),
      })

      if (started.type === 'replay') {
        res.setHeader('x-idempotent-replay', 'true')
        return void res.status(started.httpStatus).json(started.body)
      }
      if (started.type === 'conflict') {
        const body: ErrorResponse = {
          error: {
            code: ErrorCode.CONFLICT,
            message: 'This idempotency key was already used with a different request payload',
          },
        }
        return void res.status(409).json(body)
      }
      if (started.type === 'in_flight') {
        const body: ErrorResponse = {
          error: {
            code: ErrorCode.REQUEST_IN_FLIGHT,
            message: 'A request with this idempotency key is already being processed',
          },
        }
        return void res.status(409).json(body)
      }

      let settled = false
      const originalJson = res.json.bind(res)
      res.json = (body: unknown) => {
        if (settled) return originalJson(body)
        settled = true
        const status = res.statusCode
        // Persist before replying, so a retry cannot arrive before the record exists.
        const persist =
          status >= 500
            ? durableIdempotencyService.fail({ scope, idempotencyKey: key })
            : durableIdempotencyService.complete({
                scope,
                idempotencyKey: key,
                httpStatus: status,
                body,
              })
        void persist
          .catch(() => undefined)
          .finally(() => {
            originalJson(body)
          })
        return res
      }

      // The client went away before we answered: release the key for its retry.
      res.on('close', () => {
        if (!settled) {
          settled = true
          void durableIdempotencyService.fail({ scope, idempotencyKey: key }).catch(() => undefined)
        }
      })

      next()
    } catch (error) {
      next(error)
    }
  }
}
