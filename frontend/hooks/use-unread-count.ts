"use client"

import { useNotifications } from "./useNotifications"

export interface UseUnreadCountResult {
  unread: number
  totalUnread: number
  notifUnread: number
  notifications: ReturnType<typeof useNotifications>["notifications"]
  notifConnected: boolean
  isConnected: boolean
}

/**
 * Unified unread-count hook — the single source of truth for all header and
 * navigation badges.
 */
export function useUnreadCount(): UseUnreadCountResult {
  const { unreadCount: notifUnread, notifications, isConnected: notifConnected } = useNotifications()

  return {
    unread: notifUnread,
    totalUnread: notifUnread,
    notifUnread,
    notifications,
    notifConnected,
    isConnected: notifConnected,
  }
}
