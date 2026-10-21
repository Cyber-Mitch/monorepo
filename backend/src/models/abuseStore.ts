/**
 * Abuse Detection Store
 * Redis-backed and in-memory implementations for abuse detection counters and events
 */

import { randomUUID } from 'crypto'
import { getRedisClient } from '../utils/redis.js'

export interface AbuseEvent {
  id: string
  target: string // IP address or user ID
  type: 'credential_stuffing' | 'scraping' | 'deal_spam' | 'manual_block'
  timestamp: Date
  expiresAt: Date
  reason?: string // For manual blocks
}

export interface AbuseBlock {
  target: string // IP address or user ID
  targetType: 'ip' | 'user'
  type: 'credential_stuffing' | 'scraping' | 'deal_spam' | 'manual_block'
  expiresAt: Date
  reason?: string
  blockedBy?: string // Admin user ID for manual blocks
  blockedAt: Date
}

export interface AbuseStore {
  // Counter operations
  incrementCounter(key: string, windowMs: number): Promise<number>
  getCounter(key: string): Promise<number>
  
  // Block operations
  setBlock(target: string, targetType: 'ip' | 'user', type: string, expiresAt: Date, reason?: string, blockedBy?: string): Promise<void>
  removeBlock(target: string, targetType: 'ip' | 'user'): Promise<void>
  getBlock(target: string, targetType: 'ip' | 'user'): Promise<AbuseBlock | null>
  listBlocks(filters?: { targetType?: 'ip' | 'user'; type?: string }): Promise<AbuseBlock[]>
  
  // Event operations
  addEvent(event: Omit<AbuseEvent, 'id' | 'timestamp'>): Promise<AbuseEvent>
  listEvents(filters?: { type?: string; target?: string }): Promise<AbuseEvent[]>
  
  // Cleanup
  clear(): Promise<void>
}

/**
 * In-memory implementation for testing
 */
export class InMemoryAbuseStore implements AbuseStore {
  private counters = new Map<string, { count: number; expiresAt: number }>()
  private blocks = new Map<string, AbuseBlock>()
  private events: AbuseEvent[] = []

  async incrementCounter(key: string, windowMs: number): Promise<number> {
    const now = Date.now()
    const record = this.counters.get(key)
    let count = 1
    if (record && record.expiresAt > now) {
      count = record.count + 1
      record.count = count
    } else {
      this.counters.set(key, { count: 1, expiresAt: now + windowMs })
    }
    return count
  }

  async getCounter(key: string): Promise<number> {
    const now = Date.now()
    const record = this.counters.get(key)
    if (!record || record.expiresAt <= now) {
      return 0
    }
    return record.count
  }

  async setBlock(
    target: string,
    targetType: 'ip' | 'user',
    type: string,
    expiresAt: Date,
    reason?: string,
    blockedBy?: string
  ): Promise<void> {
    const block: AbuseBlock = {
      target,
      targetType,
      type: type as any,
      expiresAt,
      reason,
      blockedBy,
      blockedAt: new Date(),
    }
    this.blocks.set(`${targetType}:${target}`, block)
  }

  async removeBlock(target: string, targetType: 'ip' | 'user'): Promise<void> {
    this.blocks.delete(`${targetType}:${target}`)
  }

  async getBlock(target: string, targetType: 'ip' | 'user'): Promise<AbuseBlock | null> {
    const block = this.blocks.get(`${targetType}:${target}`)
    if (!block) return null
    
    const now = new Date()
    if (block.expiresAt <= now) {
      this.blocks.delete(`${targetType}:${target}`)
      return null
    }
    
    return block
  }

  async listBlocks(filters?: { targetType?: 'ip' | 'user'; type?: string }): Promise<AbuseBlock[]> {
    const now = new Date()
    let blocks = Array.from(this.blocks.values()).filter((b) => b.expiresAt > now)
    
    if (filters?.targetType) {
      blocks = blocks.filter((b) => b.targetType === filters.targetType)
    }
    if (filters?.type) {
      blocks = blocks.filter((b) => b.type === filters.type)
    }
    
    return blocks.sort((a, b) => b.blockedAt.getTime() - a.blockedAt.getTime())
  }

  async addEvent(event: Omit<AbuseEvent, 'id' | 'timestamp'>): Promise<AbuseEvent> {
    const fullEvent: AbuseEvent = {
      id: randomUUID(),
      target: event.target,
      type: event.type,
      timestamp: new Date(),
      expiresAt: event.expiresAt,
      reason: event.reason,
    }
    this.events.push(fullEvent)
    return fullEvent
  }

  async listEvents(filters?: { type?: string; target?: string }): Promise<AbuseEvent[]> {
    const now = new Date()
    let events = this.events.filter((e) => e.expiresAt > now)
    
    if (filters?.type) {
      events = events.filter((e) => e.type === filters.type)
    }
    if (filters?.target) {
      events = events.filter((e) => e.target === filters.target)
    }
    
    return events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  async clear(): Promise<void> {
    this.counters.clear()
    this.blocks.clear()
    this.events.length = 0
  }
}

/**
 * Redis-backed implementation for production
 */
export class RedisAbuseStore implements AbuseStore {
  private readonly redis
  
  constructor() {
    this.redis = getRedisClient()
  }

  async incrementCounter(key: string, windowMs: number): Promise<number> {
    const ttlSeconds = Math.floor(windowMs / 1000)
    const current = await this.redis.incr(`abuse:counter:${key}`)
    if (current === 1) {
      await this.redis.expire(`abuse:counter:${key}`, ttlSeconds)
    }
    return current
  }

  async getCounter(key: string): Promise<number> {
    const val = await this.redis.get(`abuse:counter:${key}`)
    return val ? parseInt(val, 10) : 0
  }

  async setBlock(
    target: string,
    targetType: 'ip' | 'user',
    type: string,
    expiresAt: Date,
    reason?: string,
    blockedBy?: string
  ): Promise<void> {
    const blockKey = `abuse:block:${targetType}:${target}`
    const ttlSeconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000)
    
    const blockData = JSON.stringify({
      target,
      targetType,
      type,
      expiresAt: expiresAt.toISOString(),
      reason,
      blockedBy,
      blockedAt: new Date().toISOString(),
    })
    
    await this.redis.set(blockKey, blockData, 'EX' as any, Math.max(ttlSeconds, 1))
  }

  async removeBlock(target: string, targetType: 'ip' | 'user'): Promise<void> {
    await this.redis.del(`abuse:block:${targetType}:${target}`)
  }

  async getBlock(target: string, targetType: 'ip' | 'user'): Promise<AbuseBlock | null> {
    const blockKey = `abuse:block:${targetType}:${target}`
    const val = await this.redis.get(blockKey)
    if (!val) return null
    
    try {
      const data = JSON.parse(val)
      const expiresAt = new Date(data.expiresAt)
      if (expiresAt <= new Date()) {
        await this.redis.del(blockKey)
        return null
      }
      
      return {
        target: data.target,
        targetType: data.targetType,
        type: data.type,
        expiresAt,
        reason: data.reason,
        blockedBy: data.blockedBy,
        blockedAt: new Date(data.blockedAt),
      }
    } catch {
      return null
    }
  }

  async listBlocks(filters?: { targetType?: 'ip' | 'user'; type?: string }): Promise<AbuseBlock[]> {
    const pattern = filters?.targetType 
      ? `abuse:block:${filters.targetType}:*`
      : `abuse:block:*`
    
    const keys = await this.redis.keys(pattern)
    const blocks: AbuseBlock[] = []
    
    for (const key of keys) {
      const val = await this.redis.get(key)
      if (!val) continue
      
      try {
        const data = JSON.parse(val)
        const expiresAt = new Date(data.expiresAt)
        if (expiresAt <= new Date()) {
          await this.redis.del(key)
          continue
        }
        
        if (filters?.type && data.type !== filters.type) continue
        
        blocks.push({
          target: data.target,
          targetType: data.targetType,
          type: data.type,
          expiresAt,
          reason: data.reason,
          blockedBy: data.blockedBy,
          blockedAt: new Date(data.blockedAt),
        })
      } catch {
        // Skip malformed entries
      }
    }
    
    return blocks.sort((a, b) => b.blockedAt.getTime() - a.blockedAt.getTime())
  }

  async addEvent(event: Omit<AbuseEvent, 'id' | 'timestamp'>): Promise<AbuseEvent> {
    const fullEvent: AbuseEvent = {
      id: randomUUID(),
      target: event.target,
      type: event.type,
      timestamp: new Date(),
      expiresAt: event.expiresAt,
      reason: event.reason,
    }
    
    const eventKey = `abuse:event:${fullEvent.id}`
    const ttlSeconds = Math.floor((event.expiresAt.getTime() - Date.now()) / 1000)
    
    const eventData = JSON.stringify(fullEvent)
    await this.redis.set(eventKey, eventData, 'EX' as any, Math.max(ttlSeconds, 1))
    
    // Also add to a list for easy retrieval
    await this.redis.lpush('abuse:events', eventData)
    await this.redis.ltrim('abuse:events', 0, 999) // Keep last 1000 events
    
    return fullEvent
  }

  async listEvents(filters?: { type?: string; target?: string }): Promise<AbuseEvent[]> {
    const eventKeys = await this.redis.keys('abuse:event:*')
    const events: AbuseEvent[] = []
    
    for (const key of eventKeys) {
      const val = await this.redis.get(key)
      if (!val) continue
      
      try {
        const data = JSON.parse(val)
        const expiresAt = new Date(data.expiresAt)
        if (expiresAt <= new Date()) {
          await this.redis.del(key)
          continue
        }
        
        if (filters?.type && data.type !== filters.type) continue
        if (filters?.target && data.target !== filters.target) continue
        
        events.push({
          id: data.id,
          target: data.target,
          type: data.type,
          timestamp: new Date(data.timestamp),
          expiresAt,
          reason: data.reason,
        })
      } catch {
        // Skip malformed entries
      }
    }
    
    return events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  async clear(): Promise<void> {
    const counterKeys = await this.redis.keys('abuse:counter:*')
    const blockKeys = await this.redis.keys('abuse:block:*')
    const eventKeys = await this.redis.keys('abuse:event:*')
    
    if (counterKeys.length > 0) await this.redis.del(...counterKeys)
    if (blockKeys.length > 0) await this.redis.del(...blockKeys)
    if (eventKeys.length > 0) await this.redis.del(...eventKeys)
    await this.redis.del('abuse:events')
  }
}

// Singleton instance
let abuseStore: AbuseStore = new InMemoryAbuseStore()

export function initAbuseStore(store: AbuseStore): void {
  abuseStore = store
}

export { abuseStore }
