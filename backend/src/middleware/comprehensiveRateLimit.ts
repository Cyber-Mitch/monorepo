import { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import type { User } from '../repositories/AuthRepository.js'
import { RateLimitTiers, RateLimitConfig } from '../config/rateLimits.js'
import { RATE_LIMIT_BYPASS_TOKEN } from '../test-helpers.js'
import {
  isIpBlocked,
  isUserBlocked,
  detectScrapingPattern,
  abuseEventStore,
} from '../services/abuseDetectionService.js'
import { slidingWindowLimiter } from '../services/SlidingWindowLimiter.js'
import { quotaService } from '../services/QuotaService.js'

export interface EndpointRateLimitConfig {
  windowMs: number
  limit: number
  skipSuccessfulRequests?: boolean
  skipFailedRequests?: boolean
}

const customEndpointLimits = new Map<string, EndpointRateLimitConfig>()

export function setEndpointRateLimit(
  method: string,
  path: string,
  config: EndpointRateLimitConfig
): void {
  const key = method ? `${method} ${path}` : path
  customEndpointLimits.set(key, config)
}

function getEndpointConfig(method: string, path: string): RateLimitConfig & { matchedKey?: string } {
  const exactKey = `${method} ${path}`
  if (customEndpointLimits.has(exactKey)) return { ...customEndpointLimits.get(exactKey)!, matchedKey: exactKey }
  if (customEndpointLimits.has(path)) return { ...customEndpointLimits.get(path)!, matchedKey: path }

  for (const [key, config] of customEndpointLimits.entries()) {
    if (path.startsWith(key) && !key.includes(' ')) {
      return { ...config, matchedKey: key }
    }
  }

  if (path.startsWith('/api/auth/request-otp') || path.startsWith('/auth/request-otp')) {
    return { windowMs: 15 * 60 * 1000, limit: 5, keyPrefix: 'auth_otp', matchedKey: 'auth_otp' }
  }
  if (path.startsWith('/api/auth/verify-otp') || path.startsWith('/auth/verify-otp')) {
    return { windowMs: 15 * 60 * 1000, limit: 10, keyPrefix: 'auth_verify', matchedKey: 'auth_verify' }
  }
  if (
    path.startsWith('/api/auth/wallet-challenge') || path.startsWith('/auth/wallet-challenge') ||
    path.startsWith('/api/auth/wallet/challenge') || path.startsWith('/auth/wallet/challenge')
  ) {
    return { windowMs: 60 * 1000, limit: 20, keyPrefix: 'auth_challenge', matchedKey: 'auth_challenge' }
  }
  if (
    path.startsWith('/api/auth/wallet-verify') || path.startsWith('/auth/wallet-verify') ||
    path.startsWith('/api/auth/wallet/verify') || path.startsWith('/auth/wallet/verify')
  ) {
    return { windowMs: 60 * 1000, limit: 20, keyPrefix: 'auth_wallet_verify', matchedKey: 'auth_wallet_verify' }
  }
  if (path.startsWith('/api/auth') || path.startsWith('/auth')) {
    return { windowMs: 60 * 1000, limit: 20, keyPrefix: 'auth', matchedKey: 'auth' }
  }

  if (method === 'POST' && (path === '/api/kyc' || path === '/api/kyc/' || path === '/kyc' || path === '/kyc/')) {
    return { ...RateLimitTiers.kyc_submit, matchedKey: 'kyc_submit' }
  }

  if (method === 'POST' && (path === '/api/deals' || path === '/api/deals/' || path === '/deals' || path === '/deals/')) {
    return { ...RateLimitTiers.deal_apply, matchedKey: 'deal_apply' }
  }

  if (method === 'POST' && (path === '/api/payments/confirm' || path === '/api/payments/confirm/' || path === '/payments/confirm' || path === '/payments/confirm/')) {
    return { ...RateLimitTiers.payment_initiate, matchedKey: 'payment_initiate' }
  }

  if (method === 'POST' && (path.startsWith('/api/staking') || path.startsWith('/staking'))) {
    return { ...RateLimitTiers.staking, matchedKey: 'staking' }
  }

  if (method === 'POST' && (path.startsWith('/api/deposits') || path.startsWith('/deposits'))) {
    return { ...RateLimitTiers.deposit, matchedKey: 'deposit' }
  }

  if (method === 'POST' && (path.startsWith('/api/wallet/ngn/withdraw') || path.startsWith('/wallet/ngn/withdraw'))) {
    return { ...RateLimitTiers.wallet_withdrawal, matchedKey: 'wallet_withdrawal' }
  }

  if (method === 'POST' && (path.startsWith('/api/wallet/ngn/topup') || path.startsWith('/wallet/ngn/topup'))) {
    return { ...RateLimitTiers.wallet_topup, matchedKey: 'wallet_topup' }
  }

  if (path.startsWith('/api/properties') || path.startsWith('/properties')) {
    return { ...RateLimitTiers.search, matchedKey: 'search' }
  }

  return { ...RateLimitTiers.public, matchedKey: 'public' }
}

export function createComprehensiveRateLimiter(options: {
  defaultWindowMs?: number
  defaultLimit?: number
} = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const bypassHeader = req.headers['x-ratelimit-bypass']
    if (bypassHeader === RATE_LIMIT_BYPASS_TOKEN) {
      return next()
    }

    const user = (req as any).user as User | undefined
    const userId = user?.id
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown'
    const endpoint = `${req.method} ${req.baseUrl}${req.path}`

    if (
      req.path === '/health' ||
      req.path.startsWith('/health/') ||
      req.path.startsWith('/openapi') ||
      req.path.startsWith('/docs')
    ) {
      return next()
    }

    try {
      const ipBlocked = await isIpBlocked(clientIp)
      if (ipBlocked && (req.path.startsWith('/api/auth') || req.path.startsWith('/auth'))) {
        res.setHeader('X-RateLimit-Limit', 5)
        res.setHeader('X-RateLimit-Remaining', 0)
        res.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + 3600 * 1000) / 1000))
        throw new AppError(
          ErrorCode.TOO_MANY_REQUESTS,
          429,
          'Your IP is temporarily blocked due to suspicious auth activity.'
        )
      }

      if (userId) {
        const userBlocked = await isUserBlocked(userId)
        if (userBlocked && req.method === 'POST' && (req.path === '/api/deals' || req.path === '/deals')) {
          throw new AppError(
            ErrorCode.TOO_MANY_REQUESTS,
            429,
            'Your account is temporarily blocked from submitting deal applications.'
          )
        }
      }

      const config = getEndpointConfig(req.method, req.path)

      if (config.keyPrefix === 'search') {
        const flagged = await detectScrapingPattern(clientIp)
        if (flagged) {
          throw new AppError(
            ErrorCode.TOO_MANY_REQUESTS,
            429,
            'Suspicious scraping pattern detected. IP blocked.'
          )
        }
      }

      const userTierLimits = await quotaService.getUserLimits(user)

      let windowMs = config.windowMs
      let limit = config.limit

      if (config.keyPrefix === 'public') {
        windowMs = options.defaultWindowMs ?? 15 * 60 * 1000
        limit = options.defaultLimit ?? userTierLimits.requestsPerMinute ?? 100
      }

      if (userId) {
        limit = limit * 2
      }

      const matchedKey = config.matchedKey || endpoint
      const identifier = userId ? `user:${userId}` : `ip:${clientIp}`
      const key = `ratelimit:${config.keyPrefix || 'api'}:${identifier}:${matchedKey}`

      const result = await slidingWindowLimiter.checkLimit(key, limit, windowMs)

      res.setHeader('X-RateLimit-Limit', result.total)
      res.setHeader('X-RateLimit-Remaining', result.remaining)
      res.setHeader('X-RateLimit-Reset', Math.ceil(result.reset / 1000))

      if (!result.allowed) {
        const retryAfter = Math.ceil((result.reset - Date.now()) / 1000)
        res.setHeader('Retry-After', retryAfter.toString())

        throw new AppError(
          ErrorCode.TOO_MANY_REQUESTS,
          429,
          'Too many requests. Please try again later.'
        )
      }

      next()
    } catch (error) {
      if (error instanceof AppError) {
        return next(error)
      }
      logger.error('Comprehensive rate limiting error:', undefined, error)
      next()
    }
  }
}

export function getRateLimitStats(): {
  totalTrackedKeys: number
  activeKeys: number
  oldestReset: number
  newestReset: number
} {
  return {
    totalTrackedKeys: 0,
    activeKeys: 0,
    oldestReset: Date.now(),
    newestReset: Date.now(),
  }
}

export async function resetRateLimitStore(): Promise<void> {
  customEndpointLimits.clear()
  await abuseEventStore.clear()
  slidingWindowLimiter.clear()
}
