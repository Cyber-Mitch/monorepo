import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OutboxWorker } from './worker.js'
import { outboxStore } from './store.js'
import { OutboxStatus, TxType } from './types.js'

// The generic OutboxWorker must leave allowlist items to AllowlistSyncWorker, so the
// two never process the same row (#1952).
describe('OutboxWorker and allowlist items', () => {
  const createAllowlistItem = () =>
    outboxStore.create({
      txType: TxType.ALLOWLIST_ADD,
      source: 'kyc_approval',
      ref: 'kyc-1',
      aggregateType: 'user',
      aggregateId: 'user-1',
      payload: { address: 'GABC123456789', label: 'approved' },
    })

  beforeEach(async () => {
    await outboxStore.clear()
  })

  afterEach(async () => {
    await outboxStore.clear()
  })

  it('does not claim or send pending allowlist items', async () => {
    const item = await createAllowlistItem()
    const sender = { send: vi.fn(async () => true) }

    await new OutboxWorker(sender as any).process()

    expect(sender.send).not.toHaveBeenCalled()
    const stored = await outboxStore.getById(item.id)
    expect(stored?.status).toBe(OutboxStatus.PENDING)
    expect(stored?.claimedBy).toBeUndefined()
  })

  it('does not retry failed allowlist items', async () => {
    const item = await createAllowlistItem()
    await outboxStore.updateStatus(item.id, OutboxStatus.FAILED, {
      error: 'rpc unavailable',
      nextRetryAt: new Date(0),
    })
    const sender = { send: vi.fn(async () => true) }

    await new OutboxWorker(sender as any).process()

    expect(sender.send).not.toHaveBeenCalled()
    const stored = await outboxStore.getById(item.id)
    expect(stored?.status).toBe(OutboxStatus.FAILED)
    expect(stored?.retryCount).toBe(1)
  })

  it('still sends ordinary pending items', async () => {
    await outboxStore.create({
      txType: TxType.RECEIPT,
      source: 'deal',
      ref: 'receipt-1',
      aggregateType: 'deal',
      aggregateId: 'deal-1',
      payload: {},
    })
    const sender = { send: vi.fn(async () => true) }

    await new OutboxWorker(sender as any).process()

    expect(sender.send).toHaveBeenCalledTimes(1)
  })
})
