/**
 * Listing trust score derived from an approved property inspection (#1904).
 *
 * This is the single source of truth for turning an inspection checklist into
 * `whistleblower_listings.trust_score`. It is a pure function: no I/O, no
 * clock, no randomness — both inspection stores call it inside their approve
 * transaction so the score and `has_verified_inspection` flip together.
 *
 * Formula
 * -------
 * 1. Each checklist item has a category weight:
 *      structural = 3, safety = 3, electrical = 2, plumbing = 2, exterior = 1
 *    (failures that can hurt occupants or the building count most).
 * 2. Items whose result is `na` are excluded entirely (they neither help nor
 *    hurt the score).
 * 3. Over the remaining (scored) items:
 *      raw = 100 * Σ(weight of passing items) / Σ(weight of all scored items)
 * 4. Safety cap: if ANY safety item failed, the score is capped at
 *    SAFETY_FAIL_CAP (60) regardless of how many other items passed — a
 *    listing with a known safety defect must never look "highly trusted".
 * 5. The result is rounded to the nearest integer and clamped to 0..100
 *    (matching the CHECK constraint on whistleblower_listings.trust_score).
 * 6. If there are no scored items (empty checklist, or every item is `na`)
 *    there is no evidence either way, so the neutral NEUTRAL_TRUST_SCORE (50,
 *    the column default) is returned.
 */

export const INSPECTION_CATEGORIES = [
  'structural',
  'plumbing',
  'electrical',
  'safety',
  'exterior',
] as const

export type InspectionCategory = (typeof INSPECTION_CATEGORIES)[number]

export const INSPECTION_RESULTS = ['pass', 'fail', 'na'] as const

export type InspectionResult = (typeof INSPECTION_RESULTS)[number]

export const CATEGORY_WEIGHTS: Readonly<Record<InspectionCategory, number>> = {
  structural: 3,
  safety: 3,
  electrical: 2,
  plumbing: 2,
  exterior: 1,
}

/** Maximum score a listing can get when at least one safety item failed. */
export const SAFETY_FAIL_CAP = 60

/** Score used when the checklist carries no pass/fail evidence. */
export const NEUTRAL_TRUST_SCORE = 50

export interface ScorableChecklistItem {
  category: InspectionCategory
  result: InspectionResult
}

/** Rounds and clamps an arbitrary number into the integer range 0..100. */
export function clampTrustScore(value: number): number {
  if (!Number.isFinite(value)) return NEUTRAL_TRUST_SCORE
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** Computes the 0..100 listing trust score for an inspection checklist. */
export function computeInspectionTrustScore(
  items: readonly ScorableChecklistItem[],
): number {
  let totalWeight = 0
  let passWeight = 0
  let safetyFailed = false

  for (const { category, result } of items) {
    if (result === 'na') continue
    const weight = CATEGORY_WEIGHTS[category]
    totalWeight += weight
    if (result === 'pass') {
      passWeight += weight
    } else if (category === 'safety') {
      safetyFailed = true
    }
  }

  if (totalWeight === 0) return NEUTRAL_TRUST_SCORE

  let score = (100 * passWeight) / totalWeight
  if (safetyFailed) score = Math.min(score, SAFETY_FAIL_CAP)

  return clampTrustScore(score)
}
