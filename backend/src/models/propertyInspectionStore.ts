/**
 * Property Inspection Store (#1904)
 * In-memory and PostgreSQL implementations over property_inspections,
 * inspection_checklist_items and inspection_photos (migrations/040).
 *
 * Every state-dependent write is guarded by the inspection's current status
 * inside the store (row lock in Postgres), so "no edits after submit" and the
 * pending -> in_progress -> submitted -> approved|rejected lifecycle hold even
 * under concurrent requests.
 *
 * approve() recomputes the listing trust score with
 * computeInspectionTrustScore() and flips
 * whistleblower_listings.has_verified_inspection in the SAME transaction as
 * the status change (Postgres), or with a compensating rollback (in-memory).
 */

import { randomUUID } from 'node:crypto'
import { getPool, type PgClientLike } from '../db.js'
import { listingStore } from './listingStore.js'
import { computeInspectionTrustScore } from '../services/inspectionTrustScore.js'
import {
  evaluateSubmitPreconditions,
  type AddInspectionPhotoInput,
  type ApproveInspectionResult,
  type ChecklistItemInput,
  type CreatePropertyInspectionInput,
  type GuardedWriteResult,
  type InspectionChecklistItem,
  type InspectionPhoto,
  type PropertyInspection,
  type PropertyInspectionStatus,
  type SubmitInspectionResult,
} from './propertyInspection.js'

export interface TransitionPatch {
  rejectionReason?: string
  reviewedBy?: string
}

export interface PropertyInspectionStore {
  create(input: CreatePropertyInspectionInput): Promise<PropertyInspection>
  findById(id: string): Promise<PropertyInspection | null>
  list(filters?: {
    status?: PropertyInspectionStatus
    limit?: number
  }): Promise<PropertyInspection[]>
  getChecklistItems(id: string): Promise<InspectionChecklistItem[]>
  getPhotos(id: string): Promise<InspectionPhoto[]>
  /** Moves `from` -> `to`; fails with invalid_state when the current status differs. */
  transition(
    id: string,
    from: PropertyInspectionStatus,
    to: PropertyInspectionStatus,
    patch?: TransitionPatch,
  ): Promise<GuardedWriteResult<PropertyInspection>>
  /** Upserts items keyed by (category, item); only while in_progress. Returns all items. */
  upsertChecklistItems(
    id: string,
    items: ChecklistItemInput[],
  ): Promise<GuardedWriteResult<InspectionChecklistItem[]>>
  /** Registers an uploaded photo; only while in_progress. */
  addPhoto(
    id: string,
    input: AddInspectionPhotoInput,
  ): Promise<GuardedWriteResult<InspectionPhoto>>
  /** in_progress -> submitted, after checking evaluateSubmitPreconditions(). */
  submit(id: string, inspectorNotes?: string): Promise<SubmitInspectionResult>
  /** submitted -> approved + listing trust score/flag update, atomically. */
  approve(id: string, reviewedBy: string): Promise<ApproveInspectionResult>
  findLatestApprovedForListing(listingId: string): Promise<PropertyInspection | null>
}

/** Minimal listing port used by the in-memory approve(). */
export interface ListingTrustWriter {
  updateTrustScore(
    listingId: string,
    trustScore: number,
    hasVerifiedInspection: boolean,
  ): Promise<unknown | null>
}

/**
 * In-memory implementation for testing
 */
export class InMemoryPropertyInspectionStore implements PropertyInspectionStore {
  private inspections: Map<string, PropertyInspection> = new Map()
  private items: Map<string, InspectionChecklistItem[]> = new Map()
  private photos: Map<string, InspectionPhoto[]> = new Map()

  constructor(private readonly listings: ListingTrustWriter = listingStore) {}

  async create(input: CreatePropertyInspectionInput): Promise<PropertyInspection> {
    const now = new Date()
    const inspection: PropertyInspection = {
      id: randomUUID(),
      listingId: input.listingId,
      inspectorId: input.inspectorId,
      status: 'pending',
      scheduledAt: input.scheduledAt,
      createdAt: now,
      updatedAt: now,
    }
    this.inspections.set(inspection.id, inspection)
    return { ...inspection }
  }

  async findById(id: string): Promise<PropertyInspection | null> {
    const inspection = this.inspections.get(id)
    return inspection ? { ...inspection } : null
  }

  async list(filters?: {
    status?: PropertyInspectionStatus
    limit?: number
  }): Promise<PropertyInspection[]> {
    let result = Array.from(this.inspections.values())
    if (filters?.status) result = result.filter((i) => i.status === filters.status)
    result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    return result.slice(0, filters?.limit ?? 50).map((i) => ({ ...i }))
  }

  async getChecklistItems(id: string): Promise<InspectionChecklistItem[]> {
    return (this.items.get(id) ?? []).map((i) => ({ ...i }))
  }

  async getPhotos(id: string): Promise<InspectionPhoto[]> {
    return (this.photos.get(id) ?? []).map((p) => ({ ...p }))
  }

  async transition(
    id: string,
    from: PropertyInspectionStatus,
    to: PropertyInspectionStatus,
    patch: TransitionPatch = {},
  ): Promise<GuardedWriteResult<PropertyInspection>> {
    const inspection = this.inspections.get(id)
    if (!inspection) return { ok: false, reason: 'not_found' }
    if (inspection.status !== from) {
      return { ok: false, reason: 'invalid_state', status: inspection.status }
    }
    const now = new Date()
    inspection.status = to
    inspection.updatedAt = now
    if (to === 'rejected') {
      inspection.rejectionReason = patch.rejectionReason
      inspection.reviewedBy = patch.reviewedBy
      inspection.reviewedAt = now
    }
    return { ok: true, value: { ...inspection } }
  }

  async upsertChecklistItems(
    id: string,
    input: ChecklistItemInput[],
  ): Promise<GuardedWriteResult<InspectionChecklistItem[]>> {
    const inspection = this.inspections.get(id)
    if (!inspection) return { ok: false, reason: 'not_found' }
    if (inspection.status !== 'in_progress') {
      return { ok: false, reason: 'invalid_state', status: inspection.status }
    }
    const now = new Date()
    const items = this.items.get(id) ?? []
    for (const entry of input) {
      const existing = items.find(
        (i) => i.category === entry.category && i.item === entry.item,
      )
      if (existing) {
        existing.result = entry.result
        existing.notes = entry.notes
        existing.updatedAt = now
      } else {
        items.push({
          id: randomUUID(),
          inspectionId: id,
          category: entry.category,
          item: entry.item,
          result: entry.result,
          notes: entry.notes,
          createdAt: now,
          updatedAt: now,
        })
      }
    }
    this.items.set(id, items)
    inspection.updatedAt = now
    return { ok: true, value: items.map((i) => ({ ...i })) }
  }

  async addPhoto(
    id: string,
    input: AddInspectionPhotoInput,
  ): Promise<GuardedWriteResult<InspectionPhoto>> {
    const inspection = this.inspections.get(id)
    if (!inspection) return { ok: false, reason: 'not_found' }
    if (inspection.status !== 'in_progress') {
      return { ok: false, reason: 'invalid_state', status: inspection.status }
    }
    const now = new Date()
    const photo: InspectionPhoto = {
      id: randomUUID(),
      inspectionId: id,
      url: input.url,
      caption: input.caption,
      takenAt: input.takenAt ?? now,
      createdAt: now,
    }
    const photos = this.photos.get(id) ?? []
    photos.push(photo)
    this.photos.set(id, photos)
    return { ok: true, value: { ...photo } }
  }

  async submit(id: string, inspectorNotes?: string): Promise<SubmitInspectionResult> {
    const inspection = this.inspections.get(id)
    if (!inspection) return { ok: false, reason: 'not_found' }
    if (inspection.status !== 'in_progress') {
      return { ok: false, reason: 'invalid_state', status: inspection.status }
    }
    const preconditions = evaluateSubmitPreconditions(
      this.items.get(id) ?? [],
      (this.photos.get(id) ?? []).length,
    )
    if (!preconditions.ok) return { ok: false, reason: 'preconditions', preconditions }

    const now = new Date()
    inspection.status = 'submitted'
    inspection.submittedAt = now
    inspection.updatedAt = now
    if (inspectorNotes !== undefined) inspection.inspectorNotes = inspectorNotes
    return { ok: true, inspection: { ...inspection } }
  }

  async approve(id: string, reviewedBy: string): Promise<ApproveInspectionResult> {
    const inspection = this.inspections.get(id)
    if (!inspection) return { ok: false, reason: 'not_found' }
    if (inspection.status !== 'submitted') {
      return { ok: false, reason: 'invalid_state', status: inspection.status }
    }

    const trustScore = computeInspectionTrustScore(this.items.get(id) ?? [])

    // Claim the transition synchronously (no await between check and write) so
    // a concurrent approve sees `approved`, then update the listing; if the
    // listing write fails, restore the snapshot (compensating rollback).
    const snapshot = { ...inspection }
    const now = new Date()
    inspection.status = 'approved'
    inspection.approvedAt = now
    inspection.reviewedBy = reviewedBy
    inspection.reviewedAt = now
    inspection.updatedAt = now

    try {
      const updated = await this.listings.updateTrustScore(
        inspection.listingId,
        trustScore,
        true,
      )
      if (!updated) {
        this.inspections.set(id, snapshot)
        return { ok: false, reason: 'listing_not_found' }
      }
    } catch (error) {
      this.inspections.set(id, snapshot)
      throw error
    }

    return { ok: true, inspection: { ...inspection }, trustScore }
  }

  async findLatestApprovedForListing(
    listingId: string,
  ): Promise<PropertyInspection | null> {
    const approved = Array.from(this.inspections.values())
      .filter((i) => i.listingId === listingId && i.status === 'approved')
      .sort(
        (a, b) => (b.approvedAt?.getTime() ?? 0) - (a.approvedAt?.getTime() ?? 0),
      )
    return approved[0] ? { ...approved[0] } : null
  }

  // Test helper
  async clear(): Promise<void> {
    this.inspections.clear()
    this.items.clear()
    this.photos.clear()
  }
}

const INSPECTION_COLUMNS = `id, listing_id, inspector_id, status, scheduled_at, submitted_at,
  approved_at, inspector_notes, rejection_reason, reviewed_by, reviewed_at,
  created_at, updated_at`

const CHECKLIST_COLUMNS = `id, inspection_id, category, item, result, notes, created_at, updated_at`

const PHOTO_COLUMNS = `id, inspection_id, url, caption, taken_at, created_at`

/**
 * PostgreSQL implementation
 */
export class PostgresPropertyInspectionStore implements PropertyInspectionStore {
  private async pool() {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    return pool
  }

  /**
   * Runs `fn` inside a transaction holding a row lock on the inspection.
   * `fn` receives the locked inspection (or null) and the client.
   */
  private async withLockedInspection<T>(
    id: string,
    fn: (inspection: PropertyInspection | null, client: PgClientLike) => Promise<T>,
  ): Promise<T> {
    const client = await (await this.pool()).connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT ${INSPECTION_COLUMNS} FROM property_inspections WHERE id = $1 FOR UPDATE`,
        [id],
      )
      const result = await fn(rows[0] ? mapInspection(rows[0]) : null, client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async create(input: CreatePropertyInspectionInput): Promise<PropertyInspection> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      `INSERT INTO property_inspections (listing_id, inspector_id, status, scheduled_at)
       VALUES ($1, $2, 'pending', $3)
       RETURNING ${INSPECTION_COLUMNS}`,
      [input.listingId, input.inspectorId, input.scheduledAt],
    )
    return mapInspection(rows[0])
  }

  async findById(id: string): Promise<PropertyInspection | null> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      `SELECT ${INSPECTION_COLUMNS} FROM property_inspections WHERE id = $1`,
      [id],
    )
    return rows[0] ? mapInspection(rows[0]) : null
  }

  async list(filters?: {
    status?: PropertyInspectionStatus
    limit?: number
  }): Promise<PropertyInspection[]> {
    const pool = await this.pool()
    const params: unknown[] = [filters?.limit ?? 50]
    let where = ''
    if (filters?.status) {
      params.push(filters.status)
      where = `WHERE status = $${params.length}`
    }
    const { rows } = await pool.query(
      `SELECT ${INSPECTION_COLUMNS} FROM property_inspections ${where}
       ORDER BY created_at DESC LIMIT $1`,
      params,
    )
    return rows.map(mapInspection)
  }

  async getChecklistItems(id: string): Promise<InspectionChecklistItem[]> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      `SELECT ${CHECKLIST_COLUMNS} FROM inspection_checklist_items
       WHERE inspection_id = $1 ORDER BY category, item`,
      [id],
    )
    return rows.map(mapChecklistItem)
  }

  async getPhotos(id: string): Promise<InspectionPhoto[]> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      `SELECT ${PHOTO_COLUMNS} FROM inspection_photos
       WHERE inspection_id = $1 ORDER BY created_at`,
      [id],
    )
    return rows.map(mapPhoto)
  }

  async transition(
    id: string,
    from: PropertyInspectionStatus,
    to: PropertyInspectionStatus,
    patch: TransitionPatch = {},
  ): Promise<GuardedWriteResult<PropertyInspection>> {
    const pool = await this.pool()
    const isRejection = to === 'rejected'
    const { rows } = await pool.query(
      `UPDATE property_inspections
       SET status = $3,
           rejection_reason = CASE WHEN $4::boolean THEN $5 ELSE rejection_reason END,
           reviewed_by = CASE WHEN $4::boolean THEN $6 ELSE reviewed_by END,
           reviewed_at = CASE WHEN $4::boolean THEN NOW() ELSE reviewed_at END,
           updated_at = NOW()
       WHERE id = $1 AND status = $2
       RETURNING ${INSPECTION_COLUMNS}`,
      [id, from, to, isRejection, patch.rejectionReason ?? null, patch.reviewedBy ?? null],
    )
    if (rows[0]) return { ok: true, value: mapInspection(rows[0]) }

    const current = await this.findById(id)
    if (!current) return { ok: false, reason: 'not_found' }
    return { ok: false, reason: 'invalid_state', status: current.status }
  }

  async upsertChecklistItems(
    id: string,
    items: ChecklistItemInput[],
  ): Promise<GuardedWriteResult<InspectionChecklistItem[]>> {
    return this.withLockedInspection(id, async (inspection, client) => {
      if (!inspection) return { ok: false, reason: 'not_found' } as const
      if (inspection.status !== 'in_progress') {
        return { ok: false, reason: 'invalid_state', status: inspection.status } as const
      }
      for (const entry of items) {
        await client.query(
          `INSERT INTO inspection_checklist_items (inspection_id, category, item, result, notes)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (inspection_id, category, item) DO UPDATE
             SET result = EXCLUDED.result,
                 notes = EXCLUDED.notes,
                 updated_at = NOW()`,
          [id, entry.category, entry.item, entry.result, entry.notes ?? null],
        )
      }
      await client.query(
        `UPDATE property_inspections SET updated_at = NOW() WHERE id = $1`,
        [id],
      )
      const { rows } = await client.query(
        `SELECT ${CHECKLIST_COLUMNS} FROM inspection_checklist_items
         WHERE inspection_id = $1 ORDER BY category, item`,
        [id],
      )
      return { ok: true, value: rows.map(mapChecklistItem) } as const
    })
  }

  async addPhoto(
    id: string,
    input: AddInspectionPhotoInput,
  ): Promise<GuardedWriteResult<InspectionPhoto>> {
    return this.withLockedInspection(id, async (inspection, client) => {
      if (!inspection) return { ok: false, reason: 'not_found' } as const
      if (inspection.status !== 'in_progress') {
        return { ok: false, reason: 'invalid_state', status: inspection.status } as const
      }
      const { rows } = await client.query(
        `INSERT INTO inspection_photos (inspection_id, url, caption, taken_at)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()))
         RETURNING ${PHOTO_COLUMNS}`,
        [id, input.url, input.caption ?? null, input.takenAt ?? null],
      )
      return { ok: true, value: mapPhoto(rows[0]) } as const
    })
  }

  async submit(id: string, inspectorNotes?: string): Promise<SubmitInspectionResult> {
    return this.withLockedInspection(id, async (inspection, client): Promise<SubmitInspectionResult> => {
      if (!inspection) return { ok: false, reason: 'not_found' }
      if (inspection.status !== 'in_progress') {
        return { ok: false, reason: 'invalid_state', status: inspection.status }
      }
      const { rows: itemRows } = await client.query(
        `SELECT DISTINCT category FROM inspection_checklist_items WHERE inspection_id = $1`,
        [id],
      )
      const { rows: photoRows } = await client.query(
        `SELECT COUNT(*)::int AS count FROM inspection_photos WHERE inspection_id = $1`,
        [id],
      )
      const preconditions = evaluateSubmitPreconditions(
        itemRows as Array<Pick<InspectionChecklistItem, 'category'>>,
        Number(photoRows[0]?.count ?? 0),
      )
      if (!preconditions.ok) return { ok: false, reason: 'preconditions', preconditions }

      const { rows } = await client.query(
        `UPDATE property_inspections
         SET status = 'submitted',
             submitted_at = NOW(),
             inspector_notes = COALESCE($2, inspector_notes),
             updated_at = NOW()
         WHERE id = $1
         RETURNING ${INSPECTION_COLUMNS}`,
        [id, inspectorNotes ?? null],
      )
      return { ok: true, inspection: mapInspection(rows[0]) }
    })
  }

  async approve(id: string, reviewedBy: string): Promise<ApproveInspectionResult> {
    const client = await (await this.pool()).connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT ${INSPECTION_COLUMNS} FROM property_inspections WHERE id = $1 FOR UPDATE`,
        [id],
      )
      if (!rows[0]) {
        await client.query('ROLLBACK')
        return { ok: false, reason: 'not_found' }
      }
      const inspection = mapInspection(rows[0])
      if (inspection.status !== 'submitted') {
        await client.query('ROLLBACK')
        return { ok: false, reason: 'invalid_state', status: inspection.status }
      }

      const { rows: itemRows } = await client.query(
        `SELECT category, result FROM inspection_checklist_items WHERE inspection_id = $1`,
        [id],
      )
      const trustScore = computeInspectionTrustScore(
        itemRows as Array<Pick<InspectionChecklistItem, 'category' | 'result'>>,
      )

      const { rows: updatedRows } = await client.query(
        `UPDATE property_inspections
         SET status = 'approved',
             approved_at = NOW(),
             reviewed_by = $2,
             reviewed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING ${INSPECTION_COLUMNS}`,
        [id, reviewedBy],
      )

      const { rows: listingRows } = await client.query(
        `UPDATE whistleblower_listings
         SET trust_score = $2,
             has_verified_inspection = TRUE,
             updated_at = NOW()
         WHERE listing_id = $1
         RETURNING listing_id`,
        [inspection.listingId, trustScore],
      )
      if (!listingRows[0]) {
        await client.query('ROLLBACK')
        return { ok: false, reason: 'listing_not_found' }
      }

      await client.query('COMMIT')
      return { ok: true, inspection: mapInspection(updatedRows[0]), trustScore }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async findLatestApprovedForListing(
    listingId: string,
  ): Promise<PropertyInspection | null> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      `SELECT ${INSPECTION_COLUMNS} FROM property_inspections
       WHERE listing_id = $1 AND status = 'approved'
       ORDER BY approved_at DESC NULLS LAST
       LIMIT 1`,
      [listingId],
    )
    return rows[0] ? mapInspection(rows[0]) : null
  }
}

function toDate(value: unknown): Date | undefined {
  return value ? new Date(value as string | Date) : undefined
}

function mapInspection(row: any): PropertyInspection {
  return {
    id: row.id,
    listingId: row.listing_id,
    inspectorId: row.inspector_id,
    status: row.status,
    scheduledAt: toDate(row.scheduled_at),
    submittedAt: toDate(row.submitted_at),
    approvedAt: toDate(row.approved_at),
    inspectorNotes: row.inspector_notes ?? undefined,
    rejectionReason: row.rejection_reason ?? undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    reviewedAt: toDate(row.reviewed_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mapChecklistItem(row: any): InspectionChecklistItem {
  return {
    id: row.id,
    inspectionId: row.inspection_id,
    category: row.category,
    item: row.item,
    result: row.result,
    notes: row.notes ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function mapPhoto(row: any): InspectionPhoto {
  return {
    id: row.id,
    inspectionId: row.inspection_id,
    url: row.url,
    caption: row.caption ?? undefined,
    takenAt: new Date(row.taken_at),
    createdAt: new Date(row.created_at),
  }
}

// Singleton instance
let propertyInspectionStore: PropertyInspectionStore =
  new InMemoryPropertyInspectionStore()

export function initPropertyInspectionStore(store: PropertyInspectionStore): void {
  propertyInspectionStore = store
}

export { propertyInspectionStore }
