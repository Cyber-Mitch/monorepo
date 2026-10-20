import type { SorobanAdapter } from '../soroban/adapter.js'
import { sealEpochIfDue, supportsEpochSealing } from '../services/epochSealService.js'
import { logger } from '../utils/logger.js'
import { observeJobRun } from './jobObservability.js'

/**
 * Seals the current epoch_rewards epoch as soon as it ends (#1965). Safe to run
 * on every instance: sealing is idempotent (see `sealEpochIfDue`), and runs on
 * one instance never overlap.
 */
export class EpochSealJob {
  private interval: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null

  constructor(
    private readonly adapter: SorobanAdapter,
    private readonly pollIntervalMs: number = 60_000,
  ) {}

  start(): void {
    if (this.interval) return
    logger.info('Starting EpochSealJob', { pollIntervalMs: this.pollIntervalMs })
    this.interval = setInterval(() => {
      void this.poll()
    }, this.pollIntervalMs)
    if (this.interval.unref) this.interval.unref()
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    if (this.running) await this.running
  }

  /** One pass. Returns true when an epoch was sealed. A pass already in progress is joined, not repeated. */
  async poll(): Promise<boolean> {
    if (this.running) {
      await this.running
      return false
    }
    let sealed = false
    this.running = observeJobRun('epoch-seal', async () => {
      if (!supportsEpochSealing(this.adapter)) return { recordsProcessed: 0 }
      try {
        const outcome = await sealEpochIfDue(this.adapter)
        sealed = outcome.status === 'sealed'
      } catch (error) {
        logger.error('EpochSealJob failed to seal the current epoch', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return { recordsProcessed: sealed ? 1 : 0 }
    }).then(() => undefined).finally(() => {
      this.running = null
    })
    await this.running
    return sealed
  }
}
