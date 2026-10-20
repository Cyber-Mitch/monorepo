/**
 * Erasure Request Store
 * In-memory and PostgreSQL implementations for the NDPA/GDPR right-to-erasure
 * request lifecycle (pending -> completed | cancelled | expired).
 *
 * The PostgreSQL implementation is the existing ErasureService
 * (services/erasureService.ts), which also performs the PII cascade on
 * confirmation and is used directly by the data-retention job. The in-memory
 * implementation mirrors its lifecycle semantics for tests / DB-less dev.
 */

import { randomUUID } from 'node:crypto'
import {
  ERASURE_CONFIRM_DAYS,
  auditErasureExpired,
  type ErasureRequest,
  type ErasureRequestStatus,
} from '../services/erasureService.js'

export interface ListErasureRequestsFilter {
  status?: ErasureRequestStatus
  limit?: number
  offset?: number
}

export interface ErasureRequestStore {
  /** Create a pending request. Throws Error('ERASURE_ALREADY_PENDING') if one exists. */
  requestErasure(userId: string): Promise<ErasureRequest>
  findPendingByUserId(userId: string): Promise<ErasureRequest | null>
  /** Most recent request for the user, regardless of status. */
  findLatestByUserId(userId: string): Promise<ErasureRequest | null>
  findById(id: string): Promise<ErasureRequest | null>
  list(filter?: ListErasureRequestsFilter): Promise<{ requests: ErasureRequest[]; total: number }>
  /** Cancel a pending request. Returns null if it is not (or no longer) pending. */
  cancelErasure(requestId: string): Promise<ErasureRequest | null>
  /** Throws Error('ERASURE_NOT_FOUND') / Error('ERASURE_NOT_PENDING'). */
  confirmErasure(requestId: string, adminUserId: string): Promise<void>
  expireOverdueRequests(now?: Date): Promise<number>
}

/**
 * In-memory implementation for testing
 */
export class InMemoryErasureRequestStore implements ErasureRequestStore {
  private requests = new Map<string, ErasureRequest>()

  async requestErasure(userId: string): Promise<ErasureRequest> {
    if (await this.findPendingByUserId(userId)) {
      throw new Error('ERASURE_ALREADY_PENDING')
    }
    const now = new Date()
    const request: ErasureRequest = {
      id: randomUUID(),
      userId,
      status: 'pending',
      requestedAt: now,
      confirmBy: new Date(now.getTime() + ERASURE_CONFIRM_DAYS * 24 * 60 * 60 * 1000),
      confirmedAt: null,
      confirmedBy: null,
    }
    this.requests.set(request.id, request)
    return { ...request }
  }

  async findPendingByUserId(userId: string): Promise<ErasureRequest | null> {
    const pending = this.sorted().find((r) => r.userId === userId && r.status === 'pending')
    return pending ? { ...pending } : null
  }

  async findLatestByUserId(userId: string): Promise<ErasureRequest | null> {
    const latest = this.sorted().find((r) => r.userId === userId)
    return latest ? { ...latest } : null
  }

  async findById(id: string): Promise<ErasureRequest | null> {
    const request = this.requests.get(id)
    return request ? { ...request } : null
  }

  async list(
    filter: ListErasureRequestsFilter = {},
  ): Promise<{ requests: ErasureRequest[]; total: number }> {
    const matching = this.sorted().filter((r) => !filter.status || r.status === filter.status)
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? 50
    return {
      requests: matching.slice(offset, offset + limit).map((r) => ({ ...r })),
      total: matching.length,
    }
  }

  async cancelErasure(requestId: string): Promise<ErasureRequest | null> {
    const request = this.requests.get(requestId)
    if (!request || request.status !== 'pending') return null
    request.status = 'cancelled'
    return { ...request }
  }

  async confirmErasure(requestId: string, adminUserId: string): Promise<void> {
    const request = this.requests.get(requestId)
    if (!request) throw new Error('ERASURE_NOT_FOUND')
    if (request.status !== 'pending') throw new Error('ERASURE_NOT_PENDING')
    request.status = 'completed'
    request.confirmedAt = new Date()
    request.confirmedBy = adminUserId
  }

  async expireOverdueRequests(now = new Date()): Promise<number> {
    let expired = 0
    for (const request of this.requests.values()) {
      if (request.status === 'pending' && request.confirmBy < now) {
        request.status = 'expired'
        auditErasureExpired(request.id, request.userId)
        expired++
      }
    }
    return expired
  }

  /** Test helper */
  clear(): void {
    this.requests.clear()
  }

  private sorted(): ErasureRequest[] {
    // Newest first; reverse() first so same-millisecond ties stay newest-first (stable sort).
    return [...this.requests.values()].reverse().sort(
      (a, b) => b.requestedAt.getTime() - a.requestedAt.getTime(),
    )
  }
}

// Singleton instance
let erasureRequestStore: ErasureRequestStore = new InMemoryErasureRequestStore()

export function initErasureRequestStore(store: ErasureRequestStore): void {
  erasureRequestStore = store
}

export { erasureRequestStore }
