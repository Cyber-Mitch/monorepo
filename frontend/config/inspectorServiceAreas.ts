/**
 * Areas an inspector can declare they cover (#1922).
 *
 * Mirror of backend/src/config/inspectorServiceAreas.ts, which is the single
 * source of truth (onboarding validation rejects anything else). Keep the two
 * lists in sync when an area is added.
 */
export const SUPPORTED_INSPECTOR_SERVICE_AREAS = [
  "Lagos",
  "Abuja",
  "Port Harcourt",
  "Ibadan",
  "Kano",
  "Enugu",
  "Kaduna",
  "Benin City",
] as const;

export type InspectorServiceArea = (typeof SUPPORTED_INSPECTOR_SERVICE_AREAS)[number];
