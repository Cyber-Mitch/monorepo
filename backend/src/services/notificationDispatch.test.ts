import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  resolveChannels,
  dispatchNotification,
  computeBackoffMs,
  MAX_DELIVERY_ATTEMPTS,
  type ChannelAdapter,
} from './notificationDispatch.js'
import { InMemoryNotificationPreferenceStore } from '../models/notificationPreferenceStore.js'

const noSleep = async () => {}

describe('computeBackoffMs', () => {
  it('grows exponentially from the base', () => {
    expect(computeBackoffMs(1, 1000, 2)).toBe(1000)
    expect(computeBackoffMs(2, 1000, 2)).toBe(2000)
    expect(computeBackoffMs(3, 1000, 2)).toBe(4000)
  })
})

describe('resolveChannels', () => {
  let store: InMemoryNotificationPreferenceStore
  beforeEach(() => {
    store = new InMemoryNotificationPreferenceStore()
  })

  it('defaults to all channels when none requested', async () => {
    expect(await resolveChannels('u1', 'payment_due', undefined, store)).toEqual(['in_app', 'email', 'push'])
  })

  it('drops channels the user opted out of for that template', async () => {
    await store.optOut('u1', 'payment_due', 'email')
    expect(await resolveChannels('u1', 'payment_due', ['email', 'in_app'], store)).toEqual(['in_app'])
  })

  it('opt-out is scoped per template', async () => {
    await store.optOut('u1', 'payment_due', 'email')
    expect(await resolveChannels('u1', 'payment_received', ['email'], store)).toEqual(['email'])
  })

  it('re-enables a channel after opt-in', async () => {
    await store.optOut('u1', 'payment_due', 'email')
    await store.optIn('u1', 'payment_due', 'email')
    expect(await resolveChannels('u1', 'payment_due', ['email'], store)).toEqual(['email'])
  })
})

describe('dispatchNotification', () => {
  let store: InMemoryNotificationPreferenceStore
  beforeEach(() => {
    store = new InMemoryNotificationPreferenceStore()
  })

  it('reaches every requested channel', async () => {
    const calls: string[] = []
    const ok: ChannelAdapter = async ({ template }) => {
      void template
      calls.push('hit')
    }
    const result = await dispatchNotification(
      'u1',
      'deal_status_changed',
      { dealId: 'd1' },
      { email: ok, in_app: ok },
      { channels: ['email', 'in_app'], store, sleep: noSleep },
    )
    expect(result.delivered).toBe(true)
    expect(result.results.map((r) => r.channel).sort()).toEqual(['email', 'in_app'])
    expect(result.results.every((r) => r.status === 'delivered')).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('does not send on a channel the user opted out of', async () => {
    await store.optOut('u1', 'payment_due', 'email')
    const email = vi.fn<ChannelAdapter>(async () => {})
    const inApp = vi.fn<ChannelAdapter>(async () => {})
    const result = await dispatchNotification(
      'u1',
      'payment_due',
      {},
      { email, in_app: inApp },
      { channels: ['email', 'in_app'], store, sleep: noSleep },
    )
    expect(email).not.toHaveBeenCalled()
    expect(inApp).toHaveBeenCalledOnce()
    expect(result.results.map((r) => r.channel)).toEqual(['in_app'])
  })

  it('honours an opt-out read from the store on every dispatch', async () => {
    const email = vi.fn<ChannelAdapter>(async () => {})
    await dispatchNotification('u1', 'kyc_approved', {}, { email }, { channels: ['email'], store, sleep: noSleep })
    expect(email).toHaveBeenCalledOnce()

    await store.optOut('u1', 'kyc_approved', 'email')
    const second = await dispatchNotification('u1', 'kyc_approved', {}, { email }, { channels: ['email'], store, sleep: noSleep })
    expect(email).toHaveBeenCalledOnce()
    expect(second.results).toEqual([])
  })

  it('retries a failing channel up to the max then marks it failed', async () => {
    const flaky = vi.fn<ChannelAdapter>(async () => {
      throw new Error('smtp timeout')
    })
    const result = await dispatchNotification(
      'u1',
      'payment_overdue',
      {},
      { email: flaky },
      { channels: ['email'], store, sleep: noSleep },
    )
    expect(flaky).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS)
    expect(result.results[0]).toMatchObject({ channel: 'email', status: 'failed', attempts: 3 })
    expect(result.results[0].error).toContain('smtp timeout')
    expect(result.delivered).toBe(false)
  })

  it('succeeds on a later attempt without exhausting retries', async () => {
    let n = 0
    const recovers: ChannelAdapter = async () => {
      n += 1
      if (n < 2) throw new Error('transient')
    }
    const result = await dispatchNotification(
      'u1',
      'kyc_approved',
      {},
      { email: recovers },
      { channels: ['email'], store, sleep: noSleep },
    )
    expect(result.results[0]).toMatchObject({ status: 'delivered', attempts: 2 })
    expect(result.delivered).toBe(true)
  })

  it('marks channels without an adapter as skipped', async () => {
    const result = await dispatchNotification(
      'u1',
      'reward_validated',
      {},
      { in_app: async () => {} },
      { channels: ['in_app', 'push'], store, sleep: noSleep },
    )
    const push = result.results.find((r) => r.channel === 'push')
    expect(push?.status).toBe('skipped')
    // delivered ignores skipped channels.
    expect(result.delivered).toBe(true)
  })
})
