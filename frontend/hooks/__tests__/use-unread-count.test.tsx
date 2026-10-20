import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useUnreadCount } from '../use-unread-count'

const mockUseNotifications = vi.fn()

vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: () => mockUseNotifications(),
}))

describe('useUnreadCount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exposes unread counts from notifications', () => {
    mockUseNotifications.mockReturnValue({
      unreadCount: 4,
      notifications: [{ id: '1', title: 'Test' }],
      isConnected: true,
    })

    const { result } = renderHook(() => useUnreadCount())

    expect(result.current.notifUnread).toBe(4)
    expect(result.current.totalUnread).toBe(4)
    expect(result.current.unread).toBe(4)
    expect(result.current.isConnected).toBe(true)
    expect(result.current.notifications).toHaveLength(1)
  })

  it('reports isConnected false when the notification stream is disconnected', () => {
    mockUseNotifications.mockReturnValue({
      unreadCount: 0,
      notifications: [],
      isConnected: false,
    })

    const { result } = renderHook(() => useUnreadCount())

    expect(result.current.totalUnread).toBe(0)
    expect(result.current.isConnected).toBe(false)
    expect(result.current.notifConnected).toBe(false)
  })
})
