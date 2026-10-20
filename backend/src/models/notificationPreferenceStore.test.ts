import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPool } from '../db.js'
import {
  PostgresNotificationPreferenceStore,
  initNotificationPreferenceStore,
  InMemoryNotificationPreferenceStore,
  notificationPreferenceStore,
} from './notificationPreferenceStore.js'

vi.mock('../db.js', () => ({ getPool: vi.fn() }))

describe('PostgresNotificationPreferenceStore', () => {
  const query = vi.fn()

  beforeEach(() => {
    query.mockReset()
    vi.mocked(getPool).mockResolvedValue({ query } as any)
  })

  it('persists an opt-out as enabled = false for that user, template and channel', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 })
    const store = new PostgresNotificationPreferenceStore()

    await store.optOut('u1', 'payment_due', 'email')

    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('ON CONFLICT (user_id, template, channel)')
    expect(params).toEqual(['u1', 'payment_due', 'email', false])
  })

  it('reads an opt-out row back as a disabled channel', async () => {
    query.mockResolvedValue({ rows: [{ enabled: false }], rowCount: 1 })
    const store = new PostgresNotificationPreferenceStore()

    expect(await store.isChannelEnabled('u1', 'payment_due', 'email')).toBe(false)
  })

  it('treats a missing row as the default (enabled)', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 })
    const store = new PostgresNotificationPreferenceStore()

    expect(await store.isChannelEnabled('u1', 'payment_due', 'email')).toBe(true)
  })

  it('lists only opt-outs when reading a user preference set', async () => {
    query.mockResolvedValue({
      rows: [{ template: 'payment_due', channel: 'email' }],
      rowCount: 1,
    })
    const store = new PostgresNotificationPreferenceStore()

    const prefs = await store.get('u1')

    expect(query.mock.calls[0][0]).toContain('enabled = FALSE')
    expect(prefs).toEqual({
      userId: 'u1',
      optOuts: [{ template: 'payment_due', channel: 'email' }],
    })
  })
})

describe('notificationPreferenceStore proxy', () => {
  beforeEach(() => {
    initNotificationPreferenceStore(new InMemoryNotificationPreferenceStore())
  })

  it('routes calls to the store that was swapped in at startup', async () => {
    const swapped = new InMemoryNotificationPreferenceStore()
    initNotificationPreferenceStore(swapped)

    await notificationPreferenceStore.optOut('u2', 'kyc_approved', 'push')

    expect(await swapped.isChannelEnabled('u2', 'kyc_approved', 'push')).toBe(false)
  })
})
