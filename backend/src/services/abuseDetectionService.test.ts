import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { v4 as uuid } from 'uuid'
import {
  abuseEventStore,
  detectCredentialStuffing,
  detectScrapingPattern,
  detectDuplicateDealSpam,
  isIpBlocked,
  isUserBlocked,
} from './abuseDetectionService.js'

/**
 * IMPORTANT CONTEXT (full write-up in the PR description):
 *
 * - There is no injectable clock anywhere in this service — it calls Date.now()/
 *   new Date() directly. "Inject the clock for expiry windows" is done here via
 *   vi.useFakeTimers()/vi.setSystemTime(), which is the standard way to get a
 *   deterministic clock without adding a clock parameter to production code.
 *
 * - userApplicationBlockStore (named in the issue as something to reuse fakes
 *   from) is not used by this service at all — it belongs to a different
 *   subsystem (late-payment escalation / tenant applications, see
 *   services/latePaymentEscalationService.ts). This service's block state
 *   lives entirely in the module-level `abuseEvents` array (checked via
 *   isIpBlocked/isUserBlocked) plus best-effort Redis keys. There is nothing
 *   to "reuse" from that store here.
 *
 * - There is no cross-signal aggregation: detectCredentialStuffing,
 *   detectScrapingPattern, and detectDuplicateDealSpam are three independent
 *   single-signal-type counters, each with its own threshold. Nothing here
 *   combines different signal types into one decision, despite the file's
 *   name/description suggesting aggregation across signal types.
 *
 * - There is no manual-override / admin-unblock function anywhere in this
 *   service (routes/abuse.ts, out of scope for this ticket, only exposes a
 *   read-only GET /events). The only "clear" primitive is
 *   abuseEventStore.clear(), which wipes ALL abuse state globally — it is not
 *   scoped to a single user/IP, so it cannot stand in for a real manual
 *   override. A test below documents this directly.
 *
 * - Each detector is NOT idempotent once past its threshold: every call above
 *   the threshold pushes another abuse event (no "is there already an active
 *   block for this target" guard before adding). A test below documents this
 *   as a finding rather than asserting the idempotency the issue expects.
 *
 * Per the pattern established on #1332/#1266/#1265: tests exercise the real,
 * current behavior of the code (driven through the exported functions, never
 * by poking the in-memory Maps directly) and explicitly flag gaps rather than
 * asserting protections that don't exist.
 */

describe('AbuseDetectionService', () => {
  beforeEach(() => {
    abuseEventStore.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('detectCredentialStuffing (per-IP threshold)', () => {
    it('does not trigger a block before the threshold is crossed (10 failed attempts)', async () => {
      const ip = `10.0.0.${uuid().slice(0, 2)}-${uuid()}`
      let triggered = false
      for (let i = 0; i < 10; i++) {
        triggered = await detectCredentialStuffing(ip)
      }
      expect(triggered).toBe(false)
      expect(await isIpBlocked(ip)).toBe(false)
    })

    it('triggers a block decision once the threshold is crossed (11th failed attempt)', async () => {
      const ip = uuid()
      let triggered = false
      for (let i = 0; i < 11; i++) {
        triggered = await detectCredentialStuffing(ip)
      }
      expect(triggered).toBe(true)
      expect(await isIpBlocked(ip)).toBe(true)

      const events = (await abuseEventStore.getAll()).filter((e) => e.target === ip)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('credential_stuffing')
    })

    it('is deterministic: identical signal sequences on independent targets produce the same decision', async () => {
      const ipA = uuid()
      const ipB = uuid()

      let resultA = false
      let resultB = false
      for (let i = 0; i < 11; i++) {
        resultA = await detectCredentialStuffing(ipA)
        resultB = await detectCredentialStuffing(ipB)
      }

      expect(resultA).toBe(true)
      expect(resultB).toBe(true)
      expect(resultA).toBe(resultB)
    })

    it('FINDING: re-evaluating an already-blocked IP stacks additional abuse events instead of being idempotent', async () => {
      const ip = uuid()
      for (let i = 0; i < 11; i++) {
        await detectCredentialStuffing(ip)
      }
      expect((await abuseEventStore.getAll()).filter((e) => e.target === ip)).toHaveLength(1)

      // Documents current behavior: further over-threshold calls keep adding events.
      await detectCredentialStuffing(ip)
      await detectCredentialStuffing(ip)

      expect((await abuseEventStore.getAll()).filter((e) => e.target === ip)).toHaveLength(3)
    })
  })

  describe('detectScrapingPattern (per-IP threshold)', () => {
    it('does not trigger before the threshold is crossed (180 hits)', async () => {
      const ip = uuid()
      let triggered = false
      for (let i = 0; i < 180; i++) {
        triggered = await detectScrapingPattern(ip)
      }
      expect(triggered).toBe(false)
      expect(await isIpBlocked(ip)).toBe(false)
    })

    it('triggers a block decision once the threshold is crossed (181st hit)', async () => {
      const ip = uuid()
      let triggered = false
      for (let i = 0; i < 181; i++) {
        triggered = await detectScrapingPattern(ip)
      }
      expect(triggered).toBe(true)
      expect(await isIpBlocked(ip)).toBe(true)

      const events = (await abuseEventStore.getAll()).filter((e) => e.target === ip)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('scraping')
    })
  })

  describe('detectDuplicateDealSpam (per user+listing threshold)', () => {
    it('does not trigger before the threshold is crossed (5 submissions)', async () => {
      const userId = uuid()
      const listingId = uuid()
      let triggered = false
      for (let i = 0; i < 5; i++) {
        triggered = await detectDuplicateDealSpam(userId, listingId)
      }
      expect(triggered).toBe(false)
      expect(await isUserBlocked(userId)).toBe(false)
    })

    it('triggers a block decision once the threshold is crossed (6th submission)', async () => {
      const userId = uuid()
      const listingId = uuid()
      let triggered = false
      for (let i = 0; i < 6; i++) {
        triggered = await detectDuplicateDealSpam(userId, listingId)
      }
      expect(triggered).toBe(true)
      expect(await isUserBlocked(userId)).toBe(true)

      const events = (await abuseEventStore.getAll()).filter((e) => e.target === userId)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('deal_spam')
    })

    it('is deterministic: identical signals for independent users produce the same decision', async () => {
      const listingId = uuid()
      const userA = uuid()
      const userB = uuid()

      let resultA = false
      let resultB = false
      for (let i = 0; i < 6; i++) {
        resultA = await detectDuplicateDealSpam(userA, listingId)
        resultB = await detectDuplicateDealSpam(userB, listingId)
      }

      expect(resultA).toBe(true)
      expect(resultB).toBe(true)
      expect(resultA).toBe(resultB)
    })

    it('FINDING: re-evaluating an already-blocked user stacks additional abuse events instead of being idempotent', async () => {
      const userId = uuid()
      const listingId = uuid()
      for (let i = 0; i < 6; i++) {
        await detectDuplicateDealSpam(userId, listingId)
      }
      expect((await abuseEventStore.getAll()).filter((e) => e.target === userId)).toHaveLength(1)

      await detectDuplicateDealSpam(userId, listingId)

      expect((await abuseEventStore.getAll()).filter((e) => e.target === userId)).toHaveLength(2)
    })
  })

  describe('block expiry lifecycle (fake clock)', () => {
    it('keeps an IP block active before its 1-hour window elapses', async () => {
      const ip = uuid()
      const start = new Date('2026-01-01T00:00:00.000Z')
      vi.useFakeTimers()
      vi.setSystemTime(start)

      for (let i = 0; i < 11; i++) {
        await detectCredentialStuffing(ip)
      }
      expect(await isIpBlocked(ip)).toBe(true)

      // Still within the 1-hour block window.
      vi.setSystemTime(new Date(start.getTime() + 30 * 60 * 1000))
      expect(await isIpBlocked(ip)).toBe(true)
    })

    it('expires an IP block once its 1-hour window elapses', async () => {
      const ip = uuid()
      const start = new Date('2026-01-01T00:00:00.000Z')
      vi.useFakeTimers()
      vi.setSystemTime(start)

      for (let i = 0; i < 11; i++) {
        await detectCredentialStuffing(ip)
      }
      expect(await isIpBlocked(ip)).toBe(true)

      // Past the 1-hour block window.
      vi.setSystemTime(new Date(start.getTime() + 61 * 60 * 1000))
      expect(await isIpBlocked(ip)).toBe(false)
    })

    it('expires a user (deal spam) block once its 1-hour window elapses', async () => {
      const userId = uuid()
      const listingId = uuid()
      const start = new Date('2026-01-01T00:00:00.000Z')
      vi.useFakeTimers()
      vi.setSystemTime(start)

      for (let i = 0; i < 6; i++) {
        await detectDuplicateDealSpam(userId, listingId)
      }
      expect(await isUserBlocked(userId)).toBe(true)

      vi.setSystemTime(new Date(start.getTime() + 61 * 60 * 1000))
      expect(await isUserBlocked(userId)).toBe(false)
    })
  })

  describe('manual override', () => {
    it('FINDING: there is no per-target manual override — abuseEventStore.clear() is the only reset, and it is global, not scoped to one user/IP', async () => {
      const blockedUser = uuid()
      const unrelatedUser = uuid()
      const listingId = uuid()
      const otherListingId = uuid()

      for (let i = 0; i < 6; i++) {
        await detectDuplicateDealSpam(blockedUser, listingId)
        await detectDuplicateDealSpam(unrelatedUser, otherListingId)
      }
      expect(await isUserBlocked(blockedUser)).toBe(true)
      expect(await isUserBlocked(unrelatedUser)).toBe(true)

      // The only available "clear" is global — it lifts every block, not just one.
      abuseEventStore.clear()

      expect(await isUserBlocked(blockedUser)).toBe(false)
      expect(await isUserBlocked(unrelatedUser)).toBe(false)
    })
  })
})
