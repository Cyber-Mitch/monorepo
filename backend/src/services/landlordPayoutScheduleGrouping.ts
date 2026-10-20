/**
 * Groups landlord payouts into weekly or monthly periods and computes the
 * schedule summary — issue #1892.
 *
 * Pure functions, no I/O. All bucketing is done in UTC so a payout scheduled
 * at 23:30 on the last day of a month lands in that month for every caller.
 *
 * Period labels match what frontend/lib/landlordPayoutApi.ts parses:
 *   monthly  "YYYY-MM"      (e.g. "2026-01")
 *   weekly   "YYYY-Www"     ISO week, Monday to Sunday (e.g. "2026-W05")
 */

import type {
  LandlordPayout,
  PayoutGrouping,
  PayoutPeriod,
  PayoutScheduleSummary,
} from '../schemas/landlordPayoutSchedule.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface PeriodBounds {
  label: string
  start: Date
  end: Date
}

function endOfDay(day: Date): Date {
  return new Date(day.getTime() + MS_PER_DAY - 1)
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export function monthlyPeriodFor(date: Date): PeriodBounds {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  const start = new Date(Date.UTC(year, month, 1))
  const end = endOfDay(new Date(Date.UTC(year, month + 1, 0)))
  const label = `${year}-${String(month + 1).padStart(2, '0')}`
  return { label, start, end }
}

export function weeklyPeriodFor(date: Date): PeriodBounds {
  const day = startOfUtcDay(date)
  // Monday = 0 … Sunday = 6
  const dayOfWeek = (day.getUTCDay() + 6) % 7
  const start = new Date(day.getTime() - dayOfWeek * MS_PER_DAY)
  const end = endOfDay(new Date(start.getTime() + 6 * MS_PER_DAY))

  // ISO week-numbering: the week belongs to the year containing its Thursday.
  const thursday = new Date(start.getTime() + 3 * MS_PER_DAY)
  const isoYear = thursday.getUTCFullYear()
  const jan1 = new Date(Date.UTC(isoYear, 0, 1))
  // 1-based day of year of the Thursday; weeks are 7-day blocks of days.
  const dayOfYear = (thursday.getTime() - jan1.getTime()) / MS_PER_DAY + 1
  const week = Math.ceil(dayOfYear / 7)
  const label = `${isoYear}-W${String(week).padStart(2, '0')}`
  return { label, start, end }
}

export function periodFor(date: Date, grouping: PayoutGrouping): PeriodBounds {
  return grouping === 'weekly' ? weeklyPeriodFor(date) : monthlyPeriodFor(date)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function summarizePayouts(payouts: LandlordPayout[]): PayoutScheduleSummary {
  let totalGross = 0
  let totalDeductions = 0
  let totalNet = 0
  let delayedPayouts = 0
  let onHoldPayouts = 0

  for (const payout of payouts) {
    totalGross += payout.grossAmount
    totalDeductions += payout.deductions.reduce((sum, d) => sum + d.amount, 0)
    totalNet += payout.netAmount
    if (payout.status === 'delayed') delayedPayouts += 1
    if (payout.status === 'on_hold') onHoldPayouts += 1
  }

  return {
    totalGross: round2(totalGross),
    totalDeductions: round2(totalDeductions),
    totalNet: round2(totalNet),
    totalPayouts: payouts.length,
    delayedPayouts,
    onHoldPayouts,
    currency: payouts[0]?.currency ?? 'NGN',
  }
}

export function groupPayoutsIntoPeriods(
  payouts: LandlordPayout[],
  grouping: PayoutGrouping,
): PayoutPeriod[] {
  const buckets = new Map<string, { bounds: PeriodBounds; payouts: LandlordPayout[] }>()

  for (const payout of payouts) {
    const bounds = periodFor(new Date(payout.scheduledDate), grouping)
    const bucket = buckets.get(bounds.label) ?? { bounds, payouts: [] }
    bucket.payouts.push(payout)
    buckets.set(bounds.label, bucket)
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.bounds.start.getTime() - b.bounds.start.getTime())
    .map(({ bounds, payouts: periodPayouts }) => {
      const sorted = [...periodPayouts].sort(
        (a, b) => Date.parse(a.scheduledDate) - Date.parse(b.scheduledDate),
      )
      const totals = sorted.reduce(
        (acc, payout) => ({
          gross: acc.gross + payout.grossAmount,
          deductions:
            acc.deductions + payout.deductions.reduce((sum, d) => sum + d.amount, 0),
          net: acc.net + payout.netAmount,
          delayed: acc.delayed + (payout.status === 'delayed' ? 1 : 0),
        }),
        { gross: 0, deductions: 0, net: 0, delayed: 0 },
      )
      return {
        periodLabel: bounds.label,
        periodStart: bounds.start.toISOString(),
        periodEnd: bounds.end.toISOString(),
        grossTotal: round2(totals.gross),
        deductionsTotal: round2(totals.deductions),
        netTotal: round2(totals.net),
        payoutCount: sorted.length,
        delayedCount: totals.delayed,
        payouts: sorted,
      }
    })
}
