import { SorobanAdapter } from '../soroban/adapter.js'
import { logger } from '../utils/logger.js'
import { outboxStore } from '../outbox/store.js'
import { OutboxStatus, TxType, type OutboxItem } from '../outbox/types.js'
import { outboxProcessor } from '../services/outboxProcessor.js'

const MAX_ALLOWLIST_SYNC_RETRIES = 5
const BASE_BACKOFF_MS = 1000

function getBackoffMs(retryCount: number): number {
  return Math.min(Math.pow(2, retryCount) * BASE_BACKOFF_MS, 60 * 60 * 1000)
}

function shouldRetry(item: OutboxItem): boolean {
  if (item.retryCount >= MAX_ALLOWLIST_SYNC_RETRIES) return false
  if (!item.nextRetryAt) return true
  return Date.now() >= new Date(item.nextRetryAt).getTime()
}

/**
 * Polls outbox records for allowlist sync and invokes allowlist_registry on Soroban.
 * Handles both ADD and REMOVE operations for KYC approval/revocation.
 */
export class AllowlistSyncWorker {
  private intervalId: NodeJS.Timeout | null = null
  private running = false
  private processingPromise: Promise<void> | null = null

  constructor(private adapter: SorobanAdapter) {}

  start(intervalMs = 30000) {
    if (this.running) return
    this.running = true
    this.intervalId = setInterval(() => {
      this.processingPromise = this.process().finally(() => {
        this.processingPromise = null
      })
    }, intervalMs)
    logger.info('AllowlistSyncWorker started', { intervalMs })
  }

  async stop() {
    this.running = false
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    if (this.processingPromise) {
      await this.processingPromise
    }
    logger.info('AllowlistSyncWorker stopped')
  }

  async process() {
    if (!this.adapter.addToAllowlist || !this.adapter.removeFromAllowlist) {
      return
    }

    const pending = await outboxStore.listByStatus(OutboxStatus.PENDING)
    const failed = await outboxStore.listByStatus(OutboxStatus.FAILED)
    const items = [...pending, ...failed].filter(
      (item) => item.txType === TxType.ALLOWLIST_ADD || item.txType === TxType.ALLOWLIST_REMOVE
    )

    for (const item of items) {
      if (item.status === OutboxStatus.FAILED && !shouldRetry(item)) {
        if (item.retryCount >= MAX_ALLOWLIST_SYNC_RETRIES) {
          // Dead-letter through the DLQ path so the item appears on the dead-letter page (#1914).
          await outboxProcessor.promoteToDeadLetter(item, 'Max allowlist sync retry count reached')
          logger.error('Allowlist sync dead-lettered', {
            outboxId: item.id,
            txType: item.txType,
            address: item.payload.address,
            retryCount: item.retryCount,
            lastError: item.lastError,
          })
        }
        continue
      }

      await this.sendAllowlistOperation(item)
    }
  }

  private async sendAllowlistOperation(item: OutboxItem): Promise<void> {
    try {
      const payload = item.payload
      const address = String(payload.address ?? '')
      const label = String(payload.label ?? 'approved')
      const expiresAt = typeof payload.expiresAt === 'number' ? payload.expiresAt : undefined

      if (!address) {
        throw new Error('Invalid ALLOWLIST_ADD/REMOVE payload: missing address')
      }

      if (item.txType === TxType.ALLOWLIST_ADD) {
        await this.adapter.addToAllowlist!(address, label, expiresAt)
        logger.info('Allowlist add succeeded', { outboxId: item.id, address, label })
      } else if (item.txType === TxType.ALLOWLIST_REMOVE) {
        await this.adapter.removeFromAllowlist!(address)
        logger.info('Allowlist remove succeeded', { outboxId: item.id, address })
      } else {
        throw new Error(`Unexpected txType for allowlist sync: ${item.txType}`)
      }

      await outboxStore.updateStatus(item.id, OutboxStatus.SENT)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const currentRetryCount = item.retryCount || 0
      const nextRetryAt = new Date(Date.now() + getBackoffMs(currentRetryCount))

      if (currentRetryCount + 1 >= MAX_ALLOWLIST_SYNC_RETRIES) {
        await outboxProcessor.promoteToDeadLetter(item, errorMessage)
        logger.error('Allowlist sync failed — dead-lettered', {
          outboxId: item.id,
          txType: item.txType,
          address: item.payload.address,
          retryCount: currentRetryCount + 1,
          lastError: errorMessage,
        })
        return
      }

      await outboxStore.updateStatus(item.id, OutboxStatus.FAILED, {
        error: errorMessage,
        nextRetryAt,
      })
      logger.warn('Allowlist sync failed — will retry', {
        outboxId: item.id,
        txType: item.txType,
        address: item.payload.address,
        retryCount: currentRetryCount + 1,
        lastError: errorMessage,
      })
    }
  }
}
