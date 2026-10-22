import { abuseStore } from '../models/abuseStore.js'
import { logger } from '../utils/logger.js'

export interface AbuseEvent {
  id: string
  target: string // IP address or user ID
  type: 'credential_stuffing' | 'scraping' | 'deal_spam' | 'manual_block'
  timestamp: Date
  expiresAt: Date
  reason?: string
}

// Thresholds and windows (documented for clarity)
const CREDENTIAL_STUFFING_THRESHOLD = 10
const CREDENTIAL_STUFFING_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
const CREDENTIAL_STUFFING_BLOCK_MS = 60 * 60 * 1000 // 1 hour

const SCRAPING_THRESHOLD = 180 // 3x search limit (60 req/min)
const SCRAPING_WINDOW_MS = 60 * 1000 // 60 seconds
const SCRAPING_BLOCK_MS = 60 * 60 * 1000 // 1 hour

const DEAL_SPAM_THRESHOLD = 5
const DEAL_SPAM_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const DEAL_SPAM_BLOCK_MS = 60 * 60 * 1000 // 1 hour

export async function detectCredentialStuffing(ip: string): Promise<boolean> {
  const key = `failed_auth:${ip}`
  const count = await abuseStore.incrementCounter(key, CREDENTIAL_STUFFING_WINDOW_MS)

  if (count > CREDENTIAL_STUFFING_THRESHOLD) {
    const expiresAt = new Date(Date.now() + CREDENTIAL_STUFFING_BLOCK_MS)
    await abuseStore.setBlock(ip, 'ip', 'credential_stuffing', expiresAt)
    await abuseStore.addEvent({
      target: ip,
      type: 'credential_stuffing',
      expiresAt,
    })
    return true
  }

  return false
}

export async function detectScrapingPattern(ip: string): Promise<boolean> {
  const key = `search_hits:${ip}`
  const count = await abuseStore.incrementCounter(key, SCRAPING_WINDOW_MS)

  if (count > SCRAPING_THRESHOLD) {
    const expiresAt = new Date(Date.now() + SCRAPING_BLOCK_MS)
    await abuseStore.setBlock(ip, 'ip', 'scraping', expiresAt)
    await abuseStore.addEvent({
      target: ip,
      type: 'scraping',
      expiresAt,
    })
    return true
  }

  return false
}

export async function detectDuplicateDealSpam(userId: string, listingId: string): Promise<boolean> {
  const key = `deal_spam:${userId}:${listingId}`
  const count = await abuseStore.incrementCounter(key, DEAL_SPAM_WINDOW_MS)

  if (count > DEAL_SPAM_THRESHOLD) {
    const expiresAt = new Date(Date.now() + DEAL_SPAM_BLOCK_MS)
    await abuseStore.setBlock(userId, 'user', 'deal_spam', expiresAt)
    await abuseStore.addEvent({
      target: userId,
      type: 'deal_spam',
      expiresAt,
    })
    return true
  }

  return false
}

export async function isIpBlocked(ip: string): Promise<boolean> {
  const block = await abuseStore.getBlock(ip, 'ip')
  return block !== null
}

export async function isUserBlocked(userId: string): Promise<boolean> {
  const block = await abuseStore.getBlock(userId, 'user')
  return block !== null
}

// Legacy exports for backward compatibility with comprehensiveRateLimit.ts
export const abuseEventStore = {
  add(event: Omit<AbuseEvent, 'id' | 'timestamp'>): Promise<AbuseEvent> {
    return abuseStore.addEvent(event)
  },
  getAll(): Promise<AbuseEvent[]> {
    return abuseStore.listEvents()
  },
  getPaginated(page: number, pageSize: number) {
    return abuseStore.listEvents().then((events) => {
      const total = events.length
      const start = (page - 1) * pageSize
      const data = events.slice(start, start + pageSize)
      return { data, total }
    })
  },
  async clear() {
    await abuseStore.clear()
  }
}
