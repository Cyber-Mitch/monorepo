/**
 * Areas an inspector can declare they cover (#1902).
 *
 * This is the single source of truth: onboarding validates `serviceAreas`
 * against this list. Add an area here to open it up; do not hard-code areas
 * anywhere else.
 */
export const SUPPORTED_INSPECTOR_SERVICE_AREAS = [
  'Lagos',
  'Abuja',
  'Port Harcourt',
  'Ibadan',
  'Kano',
  'Enugu',
  'Kaduna',
  'Benin City',
] as const

export type InspectorServiceArea = (typeof SUPPORTED_INSPECTOR_SERVICE_AREAS)[number]

export function isSupportedInspectorServiceArea(area: string): area is InspectorServiceArea {
  return (SUPPORTED_INSPECTOR_SERVICE_AREAS as readonly string[]).includes(area)
}
