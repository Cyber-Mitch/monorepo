'use client'

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useLocale } from 'next-intl'
import usePreferencesStore from '@/store/usePreferencesStore'
import { formatByPreference, formatDual, type DisplayCurrency } from '@/lib/currency'

interface CurrencyContextValue {
  displayCurrency: DisplayCurrency
  isHydrated: boolean
  setDisplayCurrency: (currency: DisplayCurrency) => Promise<void>
  formatAmount: (amountNgn: number | string, amountUsdc: number | string) => string
  formatDual: (amountNgn: number | string, amountUsdc: number | string) => string
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null)

const subscribeToPreferencesHydration = (onStoreChange: () => void) =>
  usePreferencesStore.persist.onFinishHydration(onStoreChange)
const getPreferencesHydrationSnapshot = () => usePreferencesStore.persist.hasHydrated()
const getServerPreferencesHydrationSnapshot = () => false

async function persistDisplayCurrency(currency: DisplayCurrency): Promise<void> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null
  if (!token) return

  await fetch('/api/user/preferences', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ displayCurrency: currency }),
  })
}

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const locale = useLocale()
  const currency = usePreferencesStore((s) => s.currency) as DisplayCurrency
  const setPreference = usePreferencesStore((s) => s.setPreference)
  const isHydrated = useSyncExternalStore(
    subscribeToPreferencesHydration,
    getPreferencesHydrationSnapshot,
    getServerPreferencesHydrationSnapshot,
  )
  const [hydrationFailed, setHydrationFailed] = useState(false)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!usePreferencesStore.persist.hasHydrated()) {
      void Promise.resolve(usePreferencesStore.persist.rehydrate()).catch(() => setHydrationFailed(true))
    }
  }, [])

  const preferencesReady = isHydrated || hydrationFailed

  const setDisplayCurrency = useCallback(
    async (next: DisplayCurrency) => {
      setPreference('currency', next)
      setTick((t) => t + 1)
      try {
        await persistDisplayCurrency(next)
      } catch {
        // Local preference still applies when offline
      }
    },
    [setPreference],
  )

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null
    if (!token) return

    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const dc = data?.user?.displayCurrency as DisplayCurrency | undefined
        if (dc === 'NGN' || dc === 'USDC') {
          setPreference('currency', dc)
          setTick((t) => t + 1)
        }
      })
      .catch(() => undefined)
  }, [setPreference])

  const value = useMemo<CurrencyContextValue>(
    () => ({
      displayCurrency: currency === 'USDC' ? 'USDC' : 'NGN',
      isHydrated: preferencesReady,
      setDisplayCurrency,
      formatAmount: (ngn, usdc) => preferencesReady
        ? formatByPreference(ngn, usdc, currency === 'USDC' ? 'USDC' : 'NGN', locale)
        : '—',
      formatDual: (ngn, usdc) => formatDual(ngn, usdc, locale),
    }),
    [currency, locale, preferencesReady, setDisplayCurrency],
  )

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>
}

export function useCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext)
  if (!ctx) {
    throw new Error('useCurrency must be used within CurrencyProvider')
  }
  return ctx
}
