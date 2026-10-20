/**
 * Soroban Event Indexer Worker
 * Polls the Soroban RPC for contract events and indexes them into PostgreSQL.
 *
 * For each contract it pages through `getEvents` from the saved `indexer_state`
 * ledger. Each page's events and the advanced ledger cursor are written in one
 * transaction, so a restart resumes from the saved ledger. Events are unique on
 * (contract_id, event_id), so replayed pages are ignored. RPC errors back off
 * exponentially (#1951).
 */

import { rpc, scValToNative } from '@stellar/stellar-sdk'
import { getPool, type PgPoolLike } from '../db.js'
import { getContractAddresses } from '../config/contractAddresses.js'
import { parseEvent, type IndexedContractEvent } from '../services/soroban/eventParsers.js'
import { logger } from '../utils/logger.js'

const INDEXER_ENABLED = process.env.SOROBAN_INDEXER_ENABLED !== 'false'
const POLL_INTERVAL_MS = parseInt(process.env.SOROBAN_INDEXER_INTERVAL_MS || '5000', 10)
const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || ''
const PAGE_LIMIT = 200
const MAX_BACKOFF_MS = 5 * 60 * 1000

/** The slice of the Soroban RPC client the indexer uses. Tests inject a fake. */
export interface SorobanEventsRpc {
  getLatestLedger(): Promise<{ sequence: number }>
  getEvents(request: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>
}

export interface SorobanEventIndexerOptions {
  /** RPC client to read events with. Built from `rpcUrl` when omitted. */
  rpc?: SorobanEventsRpc
  rpcUrl?: string
  /** Contracts to index. Defaults to the configured contract addresses. */
  getContractIds?: () => string[]
  getPool?: () => Promise<PgPoolLike | null>
  pollIntervalMs?: number
}

/** A decoded RPC event, ready to store. `eventId` is the Soroban event id. */
export type DecodedContractEvent = IndexedContractEvent & { eventId: string }

/**
 * Converts an XDR-decoded value to plain JSON. BigInts become strings, Maps become
 * objects and byte arrays become hex, so the stored shape is stable.
 */
export function toJsonValue(value: unknown): unknown {
  const replacer = (_key: string, v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString()
    if (v instanceof Map) return Object.fromEntries(v)
    if (v instanceof Uint8Array) return Buffer.from(v).toString('hex')
    return v
  }
  // JSON.stringify returns undefined for void values; store those as null.
  const json = JSON.stringify(value, replacer)
  return json === undefined ? null : JSON.parse(json)
}

/** Decodes one RPC event into the shape `indexed_contract_events` stores. */
export function decodeRpcEvent(event: rpc.Api.EventResponse): DecodedContractEvent | null {
  const parsed = parseEvent({
    contractId: event.contractId?.toString() ?? '',
    ledgerSequence: event.ledger,
    transactionHash: event.txHash,
    topics: event.topic.map((topic) => toJsonValue(scValToNative(topic))),
    data: toJsonValue(scValToNative(event.value)),
  })
  if (!parsed) return null
  return { ...parsed, eventId: event.id }
}

/** Exponential back-off after consecutive failed polls, capped. */
export function computeBackoffDelayMs(baseMs: number, consecutiveFailures: number): number {
  return Math.min(baseMs * Math.pow(2, consecutiveFailures), MAX_BACKOFF_MS)
}

class SorobanEventIndexer {
  private isRunning = false
  private isPaused = false
  private pollTimer?: NodeJS.Timeout
  private currentPoll: Promise<void> | null = null
  private consecutiveFailures = 0
  private rpcClient: SorobanEventsRpc | null
  private readonly rpcUrl: string
  private readonly pollIntervalMs: number
  private readonly getContractIds: () => string[]
  private readonly getPoolFn: () => Promise<PgPoolLike | null>

  constructor(options: SorobanEventIndexerOptions = {}) {
    this.rpcClient = options.rpc ?? null
    this.rpcUrl = options.rpcUrl ?? SOROBAN_RPC_URL
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    this.getContractIds = options.getContractIds ?? getContractAddresses
    this.getPoolFn = options.getPool ?? getPool

    if (!INDEXER_ENABLED) {
      logger.info('Soroban Event Indexer is disabled via SOROBAN_INDEXER_ENABLED')
    }
  }

  /**
   * Start the indexer. The first poll runs right away; later polls run on the
   * interval, or on a back-off after failures.
   */
  async start(): Promise<void> {
    if (!INDEXER_ENABLED) {
      logger.info('Soroban Event Indexer is disabled, not starting')
      return
    }

    if (this.isRunning) {
      logger.warn('Soroban Event Indexer is already running')
      return
    }

    if (!this.rpcClient) {
      if (!this.rpcUrl) {
        logger.warn('SOROBAN_RPC_URL not configured, indexer will not start')
        return
      }
      this.rpcClient = new rpc.Server(this.rpcUrl)
    }

    this.isRunning = true
    this.isPaused = false
    logger.info('Starting Soroban Event Indexer', {
      interval: this.pollIntervalMs,
      rpcUrl: this.rpcUrl,
    })

    this.scheduleNext(0)
  }

  /**
   * Stop the indexer and wait for an in-flight poll to finish, so no page is left
   * half-written.
   */
  async stop(): Promise<void> {
    this.isRunning = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
    if (this.currentPoll) {
      await this.currentPoll
    }
    logger.info('Soroban Event Indexer stopped')
  }

  /**
   * Pause the indexer
   */
  pause(): void {
    this.isPaused = true
    logger.info('Soroban Event Indexer paused')
  }

  /**
   * Resume the indexer
   */
  resume(): void {
    this.isPaused = false
    logger.info('Soroban Event Indexer resumed')
  }

  private scheduleNext(delayMs: number): void {
    if (!this.isRunning) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      this.currentPoll = this.tick().finally(() => {
        this.currentPoll = null
      })
    }, delayMs)
  }

  private async tick(): Promise<void> {
    const ok = await this.poll()
    this.consecutiveFailures = ok ? 0 : this.consecutiveFailures + 1
    const delay = ok
      ? this.pollIntervalMs
      : computeBackoffDelayMs(this.pollIntervalMs, this.consecutiveFailures)
    this.scheduleNext(delay)
  }

  /**
   * Index every configured contract once. Returns false when a contract failed, so
   * the caller backs off.
   */
  private async poll(): Promise<boolean> {
    if (!this.isRunning || this.isPaused) {
      return true
    }

    try {
      const pool = await this.getPoolFn()
      if (!pool) {
        logger.warn('Database pool not available, skipping indexer poll')
        return true
      }

      const contractIds = this.getContractIds()
      if (contractIds.length === 0) {
        logger.debug('No contract addresses configured, skipping indexer poll')
        return true
      }

      for (const contractId of contractIds) {
        await this.indexContract(pool, contractId)
      }
      return true
    } catch (error) {
      logger.error('Error in indexer poll', {
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * Page through events for one contract from the saved ledger cursor.
   */
  private async indexContract(pool: PgPoolLike, contractId: string): Promise<void> {
    const savedLedger = await this.readCursor(pool, contractId)
    const client = this.requireRpc()
    const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds: [contractId] }]

    let cursor: string | undefined
    let startLedger = savedLedger + 1
    if (savedLedger === 0) {
      // First run for this contract: index from the current ledger onward.
      startLedger = (await client.getLatestLedger()).sequence
    }

    for (;;) {
      const page = await client.getEvents(
        cursor
          ? { filters, cursor, limit: PAGE_LIMIT }
          : { filters, startLedger, limit: PAGE_LIMIT },
      )

      const decoded = page.events
        .map((event) => decodeRpcEvent(event))
        .filter((event): event is DecodedContractEvent => event !== null)
      const isLastPage = page.events.length < PAGE_LIMIT

      // On the last page every event up to latestLedger has been read, so the cursor
      // can move to latestLedger. Earlier pages can end partway through a ledger, so
      // they stop one ledger short. Replaying that ledger is harmless.
      const maxEventLedger = page.events.reduce((max, event) => Math.max(max, event.ledger), 0)
      const advanceTo = isLastPage ? page.latestLedger : maxEventLedger - 1

      await this.persistPage(pool, contractId, decoded, advanceTo)

      if (isLastPage) return
      cursor = page.cursor
    }
  }

  private async readCursor(pool: PgPoolLike, contractId: string): Promise<number> {
    await pool.query(
      `INSERT INTO indexer_state (contract_id, last_ledger_sequence)
       VALUES ($1, 0)
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId],
    )
    const result = await pool.query(
      'SELECT last_ledger_sequence FROM indexer_state WHERE contract_id = $1',
      [contractId],
    )
    return Number(result.rows[0]?.last_ledger_sequence ?? 0)
  }

  /**
   * Store one page of events and advance the cursor in the same transaction.
   */
  private async persistPage(
    pool: PgPoolLike,
    contractId: string,
    events: DecodedContractEvent[],
    advanceTo: number,
  ): Promise<void> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      for (const event of events) {
        await client.query(
          `INSERT INTO indexed_contract_events
           (event_id, contract_id, ledger_sequence, transaction_hash, event_type, topic_1, topic_2, data_json, indexed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (contract_id, event_id) DO NOTHING`,
          [
            event.eventId,
            event.contractId,
            event.ledgerSequence,
            event.transactionHash,
            event.eventType,
            event.topic1 ?? null,
            event.topic2 ?? null,
            JSON.stringify(event.dataJson),
            event.indexedAt,
          ],
        )
      }

      await client.query(
        `UPDATE indexer_state
         SET last_ledger_sequence = GREATEST(last_ledger_sequence, $2), updated_at = NOW()
         WHERE contract_id = $1`,
        [contractId, advanceTo],
      )

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private requireRpc(): SorobanEventsRpc {
    if (!this.rpcClient) {
      throw new Error('Soroban RPC client is not initialised')
    }
    return this.rpcClient
  }

  /**
   * Get indexer metrics
   */
  getMetrics(): {
    isRunning: boolean
    isPaused: boolean
    pollInterval: number
    enabled: boolean
  } {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      pollInterval: this.pollIntervalMs,
      enabled: INDEXER_ENABLED,
    }
  }
}

export { SorobanEventIndexer }

// Export singleton instance
export const sorobanEventIndexer = new SorobanEventIndexer()
