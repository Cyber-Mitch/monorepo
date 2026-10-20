import { describe, it, expect } from 'vitest'
import {
  CATEGORY_WEIGHTS,
  INSPECTION_CATEGORIES,
  NEUTRAL_TRUST_SCORE,
  SAFETY_FAIL_CAP,
  clampTrustScore,
  computeInspectionTrustScore,
  type InspectionResult,
  type ScorableChecklistItem,
} from './inspectionTrustScore.js'

function everyCategory(result: InspectionResult): ScorableChecklistItem[] {
  return INSPECTION_CATEGORIES.map((category) => ({ category, result }))
}

describe('computeInspectionTrustScore', () => {
  it('returns 100 when every item passes', () => {
    expect(computeInspectionTrustScore(everyCategory('pass'))).toBe(100)
  })

  it('returns 0 when every item fails', () => {
    expect(computeInspectionTrustScore(everyCategory('fail'))).toBe(0)
  })

  it('returns the neutral score when every item is na', () => {
    expect(computeInspectionTrustScore(everyCategory('na'))).toBe(NEUTRAL_TRUST_SCORE)
  })

  it('returns the neutral score for an empty checklist', () => {
    expect(computeInspectionTrustScore([])).toBe(NEUTRAL_TRUST_SCORE)
  })

  it('excludes na items from the denominator', () => {
    expect(
      computeInspectionTrustScore([
        { category: 'plumbing', result: 'pass' },
        { category: 'structural', result: 'na' },
        { category: 'exterior', result: 'na' },
      ]),
    ).toBe(100)
  })

  it('weights categories: structural (3) outweighs exterior (1)', () => {
    expect(CATEGORY_WEIGHTS.structural).toBe(3)
    expect(CATEGORY_WEIGHTS.exterior).toBe(1)
    // 3 / (3 + 1) = 75
    expect(
      computeInspectionTrustScore([
        { category: 'structural', result: 'pass' },
        { category: 'exterior', result: 'fail' },
      ]),
    ).toBe(75)
    // 1 / (3 + 1) = 25
    expect(
      computeInspectionTrustScore([
        { category: 'structural', result: 'fail' },
        { category: 'exterior', result: 'pass' },
      ]),
    ).toBe(25)
  })

  it('computes a mixed checklist and rounds to an integer', () => {
    // pass: structural 3 + plumbing 2 + exterior 1 = 6
    // fail: electrical 2 ; na: safety (excluded) -> 6 / 8 = 75
    expect(
      computeInspectionTrustScore([
        { category: 'structural', result: 'pass' },
        { category: 'plumbing', result: 'pass' },
        { category: 'electrical', result: 'fail' },
        { category: 'safety', result: 'na' },
        { category: 'exterior', result: 'pass' },
      ]),
    ).toBe(75)
    // 2 / 3 = 66.67 -> 67
    expect(
      computeInspectionTrustScore([
        { category: 'exterior', result: 'pass' },
        { category: 'exterior', result: 'pass' },
        { category: 'exterior', result: 'fail' },
      ]),
    ).toBe(67)
  })

  it('caps the score when any safety item fails', () => {
    const items: ScorableChecklistItem[] = [
      ...Array.from({ length: 10 }, () => ({ category: 'structural' as const, result: 'pass' as const })),
      { category: 'safety', result: 'fail' },
    ]
    // uncapped would be 30 / 33 = 91
    expect(computeInspectionTrustScore(items)).toBe(SAFETY_FAIL_CAP)
  })

  it('does not raise a score that is already below the safety cap', () => {
    expect(
      computeInspectionTrustScore([
        { category: 'safety', result: 'fail' },
        { category: 'exterior', result: 'pass' },
      ]),
    ).toBe(25)
  })

  it('does not cap when a non-safety item fails', () => {
    const items: ScorableChecklistItem[] = [
      ...Array.from({ length: 10 }, () => ({ category: 'safety' as const, result: 'pass' as const })),
      { category: 'structural', result: 'fail' },
    ]
    // 30 / 33 = 90.9 -> 91
    expect(computeInspectionTrustScore(items)).toBe(91)
  })

  it('always stays within 0..100', () => {
    const results: InspectionResult[] = ['pass', 'fail', 'na']
    for (const a of results) {
      for (const b of results) {
        for (const category of INSPECTION_CATEGORIES) {
          const score = computeInspectionTrustScore([
            { category, result: a },
            { category: 'safety', result: b },
          ])
          expect(score).toBeGreaterThanOrEqual(0)
          expect(score).toBeLessThanOrEqual(100)
          expect(Number.isInteger(score)).toBe(true)
        }
      }
    }
  })
})

describe('clampTrustScore', () => {
  it('clamps to 0..100 and rounds', () => {
    expect(clampTrustScore(-5)).toBe(0)
    expect(clampTrustScore(150)).toBe(100)
    expect(clampTrustScore(49.5)).toBe(50)
    expect(clampTrustScore(0)).toBe(0)
    expect(clampTrustScore(100)).toBe(100)
  })

  it('falls back to the neutral score for non-finite input', () => {
    expect(clampTrustScore(Number.NaN)).toBe(NEUTRAL_TRUST_SCORE)
  })
})
