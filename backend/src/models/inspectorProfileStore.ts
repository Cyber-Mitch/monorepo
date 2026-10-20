/**
 * Inspector Profile Store
 *
 * Reads and writes `inspector_profiles` (migrations/040). Used by:
 *   - the inspector onboarding routes (#1902): self-service bio and service areas
 *   - the admin verify / suspend routes (#1902), which set verification_status
 *   - requireVerifiedInspector (#1904): gates inspection work on 'verified'
 */

import { getPool } from '../db.js'

export type InspectorVerificationStatus = 'pending' | 'verified' | 'suspended'

export interface InspectorProfile {
  userId: string
  verificationStatus: InspectorVerificationStatus
  bio: string | null
  serviceAreas: string[]
  completedInspections: number
  createdAt: Date
  updatedAt: Date
}

export interface InspectorOnboardingData {
  bio: string
  serviceAreas: string[]
}

export interface InspectorProfileStore {
  getByUserId(userId: string): Promise<InspectorProfile | null>
  listByStatus(status?: InspectorVerificationStatus): Promise<InspectorProfile[]>
  /** Creates or updates the profile's self-service fields and sets it to 'pending'. */
  submitOnboarding(userId: string, data: InspectorOnboardingData): Promise<InspectorProfile>
  setVerificationStatus(
    userId: string,
    status: InspectorVerificationStatus,
  ): Promise<InspectorProfile>
}

function blankProfile(userId: string, status: InspectorVerificationStatus): InspectorProfile {
  const now = new Date()
  return {
    userId,
    verificationStatus: status,
    bio: null,
    serviceAreas: [],
    completedInspections: 0,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * In-memory implementation for testing
 */
export class InMemoryInspectorProfileStore implements InspectorProfileStore {
  private profiles: Map<string, InspectorProfile> = new Map()

  async getByUserId(userId: string): Promise<InspectorProfile | null> {
    const profile = this.profiles.get(userId)
    return profile ? { ...profile, serviceAreas: [...profile.serviceAreas] } : null
  }

  async listByStatus(status?: InspectorVerificationStatus): Promise<InspectorProfile[]> {
    return Array.from(this.profiles.values())
      .filter((profile) => !status || profile.verificationStatus === status)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((profile) => ({ ...profile, serviceAreas: [...profile.serviceAreas] }))
  }

  async submitOnboarding(
    userId: string,
    data: InspectorOnboardingData,
  ): Promise<InspectorProfile> {
    const existing = this.profiles.get(userId)
    const profile: InspectorProfile = {
      ...(existing ?? blankProfile(userId, 'pending')),
      verificationStatus: 'pending',
      bio: data.bio,
      serviceAreas: [...data.serviceAreas],
      updatedAt: new Date(),
    }
    this.profiles.set(userId, profile)
    return { ...profile, serviceAreas: [...profile.serviceAreas] }
  }

  async setVerificationStatus(
    userId: string,
    status: InspectorVerificationStatus,
  ): Promise<InspectorProfile> {
    const existing = this.profiles.get(userId)
    const profile: InspectorProfile = {
      ...(existing ?? blankProfile(userId, status)),
      verificationStatus: status,
      updatedAt: new Date(),
    }
    this.profiles.set(userId, profile)
    return { ...profile, serviceAreas: [...profile.serviceAreas] }
  }

  // Test helper
  async clear(): Promise<void> {
    this.profiles.clear()
  }
}

const PROFILE_COLUMNS = `user_id, verification_status, bio, service_areas,
       completed_inspections, created_at, updated_at`

/**
 * PostgreSQL implementation
 */
export class PostgresInspectorProfileStore implements InspectorProfileStore {
  async getByUserId(userId: string): Promise<InspectorProfile | null> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `SELECT ${PROFILE_COLUMNS}
       FROM inspector_profiles
       WHERE user_id = $1`,
      [userId],
    )
    return result.rows[0] ? this.mapRow(result.rows[0]) : null
  }

  async listByStatus(status?: InspectorVerificationStatus): Promise<InspectorProfile[]> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = status
      ? await pool.query(
          `SELECT ${PROFILE_COLUMNS}
           FROM inspector_profiles
           WHERE verification_status = $1
           ORDER BY created_at ASC`,
          [status],
        )
      : await pool.query(
          `SELECT ${PROFILE_COLUMNS}
           FROM inspector_profiles
           ORDER BY created_at ASC`,
        )
    return result.rows.map((row: any) => this.mapRow(row))
  }

  async submitOnboarding(
    userId: string,
    data: InspectorOnboardingData,
  ): Promise<InspectorProfile> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `INSERT INTO inspector_profiles (user_id, verification_status, bio, service_areas)
       VALUES ($1, 'pending', $2, $3::jsonb)
       ON CONFLICT (user_id) DO UPDATE
         SET verification_status = 'pending',
             bio = EXCLUDED.bio,
             service_areas = EXCLUDED.service_areas,
             updated_at = NOW()
       RETURNING ${PROFILE_COLUMNS}`,
      [userId, data.bio, JSON.stringify(data.serviceAreas)],
    )
    return this.mapRow(result.rows[0])
  }

  async setVerificationStatus(
    userId: string,
    status: InspectorVerificationStatus,
  ): Promise<InspectorProfile> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `INSERT INTO inspector_profiles (user_id, verification_status)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET verification_status = EXCLUDED.verification_status,
             updated_at = NOW()
       RETURNING ${PROFILE_COLUMNS}`,
      [userId, status],
    )
    return this.mapRow(result.rows[0])
  }

  private mapRow(row: any): InspectorProfile {
    return {
      userId: row.user_id,
      verificationStatus: row.verification_status,
      bio: row.bio ?? null,
      serviceAreas: Array.isArray(row.service_areas) ? row.service_areas : [],
      completedInspections: Number(row.completed_inspections ?? 0),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }
  }
}

// Singleton instance
let inspectorProfileStore: InspectorProfileStore =
  new InMemoryInspectorProfileStore()

export function initInspectorProfileStore(store: InspectorProfileStore): void {
  inspectorProfileStore = store
}

export { inspectorProfileStore }
