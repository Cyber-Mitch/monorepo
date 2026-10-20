import { describe, it, expect } from 'vitest'
import {
  groupPayoutsIntoPeriods,
  monthlyPeriodFor,
  summarizePayouts,
  weeklyPeriodFor,
} from './landlordPayoutScheduleGrouping.js'
import type { LandlordPayout } from '../schemas/landlordPayoutSchedule.js'

function payout(overrides: Partial<LandlordPayout> & { scheduledDate: string }): LandlordPayout {
  return {
    id: overrides.id ?? `PAY-${overrides.scheduledDate}`,
    landlordId: 'landlord-1',
    propertyId: 'prop-1',
    propertyName: 'Lekki Flat',
    completedDate: null,
    grossAmount: 100,
    deductions: [],
    netAmount: 100,
    currency: 'NGN',
    status: 'scheduled',
    channel: 'bank_transfer',
    delayReasons: [],
    periodStart: overrides.scheduledDate,
    periodEnd: overrides.scheduledDate,
    createdAt: overrides.scheduledDate,
    updatedAt: overrides.scheduledDate,
    ...overrides,
  }
}

describe('monthlyPeriodFor', () => {
  it('buckets a late-January date into January and its bounds cover the whole month', () => {
    const period = monthlyPeriodFor(new Date('2026-01-31T23:30:00.000Z'))
    expect(period.label).toBe('2026-01')
    expect(period.start.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(period.end.toISOString()).toBe('2026-01-31T23:59:59.999Z')
  })

  it('handles a leap-year February', () => {
    const period = monthlyPeriodFor(new Date('2028-02-10T00:00:00.000Z'))
    expect(period.end.toISOString()).toBe('2028-02-29T23:59:59.999Z')
  })
})

describe('weeklyPeriodFor (ISO weeks)', () => {
  it('puts a Sunday in the week that started the previous Monday', () => {
    const period = weeklyPeriodFor(new Date('2026-01-04T12:00:00.000Z'))
    expect(period.label).toBe('2026-W01')
    expect(period.start.toISOString()).toBe('2025-12-29T00:00:00.000Z')
    expect(period.end.toISOString()).toBe('2026-01-04T23:59:59.999Z')
  })

  it('numbers a week that spans the year boundary with the ISO year it belongs to', () => {
    // Monday 2025-12-29 belongs to ISO week 1 of 2026 (its Thursday is 2026-01-01).
    expect(weeklyPeriodFor(new Date('2025-12-29T00:00:00.000Z')).label).toBe('2026-W01')
    // Sunday 2025-12-28 is still week 52 of 2025.
    expect(weeklyPeriodFor(new Date('2025-12-28T00:00:00.000Z')).label).toBe('2025-W52')
  })

  it('numbers the first week of a year that starts on a Friday correctly', () => {
    // 2027-01-01 is a Friday; ISO week 1 of 2027 starts Monday 2027-01-04.
    expect(weeklyPeriodFor(new Date('2027-01-01T00:00:00.000Z')).label).toBe('2026-W53')
    expect(weeklyPeriodFor(new Date('2027-01-07T00:00:00.000Z')).label).toBe('2027-W01')
  })

  it('pads single-digit week numbers', () => {
    expect(weeklyPeriodFor(new Date('2026-01-15T00:00:00.000Z')).label).toBe('2026-W03')
  })
})

describe('groupPayoutsIntoPeriods', () => {
  it('groups across a month boundary and orders periods chronologically', () => {
    const periods = groupPayoutsIntoPeriods(
      [
        payout({ scheduledDate: '2026-02-01T09:00:00.000Z', grossAmount: 300, netAmount: 280 }),
        payout({ scheduledDate: '2026-01-31T18:00:00.000Z', grossAmount: 200, netAmount: 190 }),
        payout({ scheduledDate: '2026-01-02T08:00:00.000Z', grossAmount: 100, netAmount: 95 }),
      ],
      'monthly',
    )

    expect(periods.map((p) => p.periodLabel)).toEqual(['2026-01', '2026-02'])
    expect(periods[0]).toMatchObject({
      grossTotal: 300,
      netTotal: 285,
      payoutCount: 2,
      delayedCount: 0,
    })
    expect(periods[1]).toMatchObject({ grossTotal: 300, netTotal: 280, payoutCount: 1 })
  })

  it('counts delayed payouts per period', () => {
    const periods = groupPayoutsIntoPeriods(
      [
        payout({ scheduledDate: '2026-01-05T00:00:00.000Z', status: 'delayed' }),
        payout({ scheduledDate: '2026-01-06T00:00:00.000Z', status: 'completed' }),
      ],
      'monthly',
    )
    expect(periods[0].delayedCount).toBe(1)
  })

  it('groups by ISO week when weekly is requested', () => {
    const periods = groupPayoutsIntoPeriods(
      [
        payout({ scheduledDate: '2025-12-29T10:00:00.000Z' }),
        payout({ scheduledDate: '2026-01-04T10:00:00.000Z' }),
        payout({ scheduledDate: '2026-01-05T10:00:00.000Z' }),
      ],
      'weekly',
    )
    expect(periods.map((p) => [p.periodLabel, p.payoutCount])).toEqual([
      ['2026-W01', 2],
      ['2026-W02', 1],
    ])
  })

  it('returns no periods for no payouts', () => {
    expect(groupPayoutsIntoPeriods([], 'monthly')).toEqual([])
  })
})

describe('summarizePayouts', () => {
  it('totals gross, deductions, net and counts delayed and on-hold payouts', () => {
    const summary = summarizePayouts([
      payout({
        scheduledDate: '2026-01-01T00:00:00.000Z',
        grossAmount: 1000,
        netAmount: 850,
        deductions: [
          { type: 'platform_fee', label: 'Platform Fee', amount: 100 },
          { type: 'maintenance_reserve', label: 'Reserve', amount: 50 },
        ],
        status: 'delayed',
      }),
      payout({
        scheduledDate: '2026-01-15T00:00:00.000Z',
        grossAmount: 500,
        netAmount: 500,
        status: 'on_hold',
      }),
    ])

    expect(summary).toEqual({
      totalGross: 1500,
      totalDeductions: 150,
      totalNet: 1350,
      totalPayouts: 2,
      delayedPayouts: 1,
      onHoldPayouts: 1,
      currency: 'NGN',
    })
  })

  it('returns zeroed totals for an empty schedule', () => {
    expect(summarizePayouts([])).toEqual({
      totalGross: 0,
      totalDeductions: 0,
      totalNet: 0,
      totalPayouts: 0,
      delayedPayouts: 0,
      onHoldPayouts: 0,
      currency: 'NGN',
    })
  })
})
