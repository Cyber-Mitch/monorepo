import { createHash } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { ErrorCode } from '../errors/errorCodes.js'
import type { ErrorResponse } from '../errors/errorCodes.js'

export const IDEMPOTENCY_DOCS_URL = 'https://docs.shelterflex.com/api/idempotency'
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Cached response stored for idempotent requests.
 */
export interface CachedResponse {
  status: number
  body: unknown
  createdAt: number
  /** SHA-256 hex digest of the request body at the time of the first call. */
  payloadHash: string
}

/**
 * Store interface for deduplication entries.
 * Default implementation is in-memory with TTL eviction.
 * Swap to a Redis-backed implementation for distributed deployments.
 */
export interface IdempotencyStore {
  get(key: string): CachedResponse | undefined
  set(key: string, value: CachedResponse): void
  has(key: string): boolean
  markInFlight(key: string): boolean
  clearInFlight(key: string): void
}

/**
 * In-memory idempotency store with automatic TTL eviction.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private cache = new Map<string, CachedResponse>()
  private inFlight = new Set<string>()
  private readonly ttlMs: number
  private evictionTimer: ReturnType<typeof setInterval> | null = null

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
    this.evictionTimer = setInterval(() => this.evict(), Math.max(ttlMs, 60_000))
    // Allow Node to exit even if the timer is running
    if (this.evictionTimer.unref) this.evictionTimer.unref()
  }

  get(key: string): CachedResponse | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key)
      return undefined
    }
    return entry
  }

  set(key: string, value: CachedResponse): void {
    this.cache.set(key, value)
    this.inFlight.delete(key)
  }

  has(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key)
      return false
    }
    return true
  }

  markInFlight(key: string): boolean {
    if (this.inFlight.has(key)) return false
    this.inFlight.add(key)
    return true
  }

  clearInFlight(key: string): void {
    this.inFlight.delete(key)
  }

  private evict(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > this.ttlMs) {
        this.cache.delete(key)
      }
    }
  }

  /** Exposed for testing */
  get size(): number {
    return this.cache.size
  }

  stop(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer)
      this.evictionTimer = null
    }
  }
}

// Default deduplication window: 24 hours
const DEFAULT_DEDUP_WINDOW_MS = parseInt(process.env.IDEMPOTENCY_TTL_MS ?? String(24 * 60 * 60 * 1000), 10)

const defaultStore = new InMemoryIdempotencyStore(DEFAULT_DEDUP_WINDOW_MS)

/**
 * Process-local idempotency. Retries that reach another instance, or arrive
 * after a restart, are processed again, so this must NOT guard routes that move
 * money; use `durableApiIdempotency` (Postgres-backed) for those.
 *
 * Middleware that enforces idempotency using the `Idempotency-Key` header.
 *
 * - If the key was seen before and the original response is cached, replay it.
 * - If the key is currently in-flight, respond 409 Conflict.
 * - Otherwise, let the request through and cache the response.
 *
 * @param store  Optional custom store (defaults to in-memory with TTL).
 */
export function idempotency(store: IdempotencyStore = defaultStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key']
    const shouldRequireKey = process.env.NODE_ENV !== 'test' || store !== defaultStore

    if (typeof key !== 'string' || key.trim() === '') {
      if (!shouldRequireKey) {
        next()
        return
      }
      const body: ErrorResponse = {
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Missing Idempotency-Key header. Mutating payment and booking requests require a UUID idempotency key.',
          details: { documentationUrl: IDEMPOTENCY_DOCS_URL },
        },
      }
      res.status(400).json(body)
      return
    }

    const trimmedKey = key.trim()
    const isLegacyHeader = req.headers['idempotency-key'] === undefined

    if (!isLegacyHeader && !UUID_RE.test(trimmedKey)) {
      const body: ErrorResponse = {
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Idempotency-Key must be a valid UUID.',
          details: { documentationUrl: IDEMPOTENCY_DOCS_URL },
        },
      }
      res.status(400).json(body)
      return
    }

    // Unauthenticated callers are scoped by IP, since no identity is available to trust.
    const userId = (req as { user?: { id?: string } }).user?.id ?? `ip:${req.ip}`
    const cacheKey = createHash('sha256').update(`${userId}:${trimmedKey}`).digest('hex')

    // Compute a hash of the incoming payload for conflict detection
    const incomingHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? null))
      .digest('hex')

    // Check for cached response
    const cached = store.get(cacheKey)
    if (cached) {
      if (cached.payloadHash !== incomingHash) {
        const body: ErrorResponse = {
          error: {
            code: ErrorCode.CONFLICT,
            message:
              'This idempotency key was already used with a different request payload',
          },
        }
        res.status(409).json(body)
        return
      }
      res.setHeader('x-idempotent-replay', 'true')
      res.status(cached.status).json(cached.body)
      return
    }

    // Check if request is already in-flight
    if (!store.markInFlight(cacheKey)) {
      const body: ErrorResponse = {
        error: {
          code: ErrorCode.REQUEST_IN_FLIGHT,
          message: 'A request with this idempotency key is already being processed',
        },
      }
      res.status(409).json(body)
      return
    }

    // Intercept res.json to capture the response
    const originalJson = res.json.bind(res)
    res.json = (body: unknown) => {
      store.set(cacheKey, {
        status: res.statusCode,
        body,
        createdAt: Date.now(),
        payloadHash: incomingHash,
      })
      return originalJson(body)
    }

    // Clean up in-flight on close (e.g. client disconnect before response)
    res.on('close', () => {
      if (!store.has(cacheKey)) {
        store.clearInFlight(cacheKey)
      }
    })

    next()
  }
}

export { defaultStore }
