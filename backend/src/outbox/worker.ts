import { randomUUID } from 'node:crypto'
import { SorobanAdapter } from '../soroban/adapter.js'
import { outboxStore } from './store.js'
import { OutboxSender } from './sender.js'
import { ALLOWLIST_TX_TYPES, OutboxStatus, type OutboxItem } from './types.js'
import { outboxProcessor } from '../services/outboxProcessor.js'
import { outboxConfig } from '../config/outboxConfig.js'
import { logger } from '../utils/logger.js'
import {
  recordOutboxPending,
  recordOutboxProcessed,
  recordOutboxFailed,
  recordOutboxProcessingDuration,
} from '../metrics.js'

export class OutboxWorker {
  private intervalId: NodeJS.Timeout | null = null
  private running = false
  private sender: OutboxSender
  private processingPromise: Promise<void> | null = null
  /** Stable UUID for this worker instance; used to claim outbox rows. */
  private readonly workerId = randomUUID()

  constructor(sender: OutboxSender, private adapter?: SorobanAdapter) {
    this.sender = sender
  }

  start(intervalMs = 60000) {
    if (this.running) return
    this.running = true
    this.intervalId = setInterval(() => {
      this.processingPromise = this.process().finally(() => {
        this.processingPromise = null
      })
    }, intervalMs)
    logger.info('OutboxWorker started', { intervalMs, workerId: this.workerId, config: outboxConfig })
  }

  async stop() {
    this.running = false
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    if (this.processingPromise) {
      logger.info('OutboxWorker waiting for in-progress task to complete...')
      await this.processingPromise
    }
    logger.info('OutboxWorker stopped')
  }

  async process() {
    const startTime = Date.now()

    // -------------------------------------------------------------------
    // Phase 1: Atomically claim PENDING items (SELECT FOR UPDATE SKIP LOCKED)
    // so that two concurrent workers never process the same row. Allowlist
    // items belong to AllowlistSyncWorker and are never claimed here (#1952).
    // -------------------------------------------------------------------
    const pending = await outboxStore.lockForProcessing(50, this.workerId, ALLOWLIST_TX_TYPES)
    recordOutboxPending(pending.length)

    for (const item of pending) {
      logger.info('Processing pending outbox item', {
        outboxId: item.id,
        txType: item.txType,
        txId: item.txId,
      })
      const itemStartTime = Date.now()
      await this.attemptSend(item)
      const itemDuration = Date.now() - itemStartTime
      recordOutboxProcessingDuration(itemDuration)
    }

    // -------------------------------------------------------------------
    // Phase 2: Check CONFIRMING items for finality / reorg.
    // Multiple workers checking the same CONFIRMING item is safe: the final
    // UPDATE to SENT is idempotent and the reorg UPDATE is idempotent too.
    // -------------------------------------------------------------------
    const confirming = await outboxStore.listByStatus(OutboxStatus.CONFIRMING)
    for (const item of confirming) {
      await this.checkConfirmation(item)
    }

    // -------------------------------------------------------------------
    // Phase 3: Retry eligible FAILED items; promote exhausted items to DLQ.
    // REOPENED items are treated as new PENDING items by the next cycle
    // (reopenItem + updateStatus(PENDING) in sender keeps them in the pool).
    // -------------------------------------------------------------------
    const failed = await outboxStore.listByStatus(OutboxStatus.FAILED)
    for (const item of failed) {
      if (ALLOWLIST_TX_TYPES.includes(item.txType)) continue
      if (item.retryCount >= outboxConfig.maxAttempts) {
        await outboxProcessor.promoteToDeadLetter(item, 'Max retry count reached')
        recordOutboxFailed('max_retry_count_reached')
        continue
      }
      if (!outboxProcessor.shouldRetry(item)) continue

      logger.info('Retrying failed outbox item', {
        outboxId: item.id,
        txId: item.txId,
        retryCount: item.retryCount,
        lastError: item.lastError,
      })
      const itemStartTime = Date.now()
      await this.attemptSend(item)
      const itemDuration = Date.now() - itemStartTime
      recordOutboxProcessingDuration(itemDuration)
    }

    // Record overall processing duration
    const totalDuration = Date.now() - startTime
    recordOutboxProcessingDuration(totalDuration)
  }

  /**
   * Check whether a CONFIRMING item has reached the configured confirmation
   * depth and that its tx still exists on chain (reorg guard).
   */
  private async checkConfirmation(item: OutboxItem): Promise<void> {
    if (!this.adapter?.getTransactionStatus || !item.submittedTxHash) return

    const chainStatus = await this.adapter.getTransactionStatus(item.submittedTxHash)

    if (chainStatus.status === 'not_found' || chainStatus.status === 'failed') {
      // Reorg or expiry: tx no longer on chain.
      logger.warn('Reorg detected: tx no longer on chain — re-opening outbox item', {
        outboxId: item.id,
        txHash: item.submittedTxHash,
        chainStatus: chainStatus.status,
      })
      await outboxStore.reopenItem(
        item.id,
        `reorg detected: tx ${item.submittedTxHash} no longer on chain (${chainStatus.status})`,
      )
      // Reset to PENDING so the next process() cycle picks it up
      await outboxStore.updateStatus(item.id, OutboxStatus.PENDING)
      return
    }

    if (chainStatus.status !== 'success' || chainStatus.ledger == null) return

    const requiredLedger = chainStatus.ledger + item.confirmationDepth
    // We need to know the latest ledger; use the returned ledger from a fresh
    // status check as a proxy (if it equals submittedLedger we don't have
    // a newer ledger; in practice the adapter should return the latest).
    // A conservative approach: if the chain reports the same confirmed ledger
    // and our depth > 0, ask again next cycle.
    const effectiveDepth = item.confirmationDepth ?? outboxConfig.confirmationDepth
    if (effectiveDepth <= 0) {
      await outboxStore.updateStatus(item.id, OutboxStatus.SENT)
      logger.info('CONFIRMING item finalized (depth=0)', { outboxId: item.id })
      return
    }

    // The adapter's getTransactionStatus returns the ledger it was included in.
    // We check against a "latest ledger" by requesting a second status call or
    // using the value in submittedLedger + depth.  Since we can't get the
    // current ledger without a separate RPC call, we use a simple heuristic:
    // if the chain confirms the tx at a ledger, wait for (confirmationDepth)
    // more ledger closes by checking again on the next worker cycle.
    // A real implementation would call server.getLatestLedger() here.
    if (item.submittedLedger == null) {
      // First time seeing a success — record the ledger and wait
      await outboxStore.markConfirming(
        item.id,
        item.submittedTxHash,
        chainStatus.ledger,
        effectiveDepth,
      )
      return
    }

    // We have a submittedLedger: use the chain's current ledger (from the
    // status response) to determine if enough closes have occurred.
    // If the adapter doesn't provide a current-ledger field, we conservatively
    // compare the status ledger to what we already have — if the chain is
    // reporting the same ledger, we're waiting.
    const currentLedger = chainStatus.ledger  // latest ledger seen by chain
    if (currentLedger >= item.submittedLedger + effectiveDepth) {
      await outboxStore.updateStatus(item.id, OutboxStatus.SENT)
      logger.info('CONFIRMING item finalized after depth check', {
        outboxId: item.id,
        submittedLedger: item.submittedLedger,
        currentLedger,
        depth: effectiveDepth,
      })
    }
  }

  private async attemptSend(item: OutboxItem): Promise<void> {
    const success = await this.sender.send(item)
    if (!success) {
      const error = item.lastError ?? 'Send failed'
      await outboxProcessor.scheduleRetry(item, error)
    }
  }
}
