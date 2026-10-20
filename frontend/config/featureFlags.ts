/**
 * Frontend Feature Flag Defaults (SSR / static fallback)
 *
 * These values are used during server-side rendering and immediately on
 * hydration, before the client fetch of /api/config/feature-flags resolves.
 *
 * To add a new flag: add one entry here. No other file needs to change.
 * Flag names must be SCREAMING_SNAKE_CASE and match the backend config.
 */
export const defaultFlags = {
  STAKING_ENABLED: true,
  INSPECTOR_DASHBOARD_ENABLED: true,
  RENT_TO_OWN_ENABLED: false,
  ADVANCED_WALLET_OPS_ENABLED: false,
  BACKEND_HEALTH_INDICATOR_ENABLED: false,
  GOVERNANCE_ENABLED: false,
} as const

export type FlagName = keyof typeof defaultFlags
export type FlagMap = Record<FlagName, boolean>
