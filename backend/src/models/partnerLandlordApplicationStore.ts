/**
 * Partner Landlord Application Store
 * In-memory and PostgreSQL implementations for the public "become a partner
 * landlord" intake form (table: partner_landlord_applications).
 */

import { randomUUID } from "node:crypto";
import { getPool } from "../db.js";

export const PARTNER_APPLICATION_STATUSES = [
  "pending",
  "contacted",
  "approved",
  "rejected",
] as const;

export type PartnerApplicationStatus =
  (typeof PARTNER_APPLICATION_STATUSES)[number];

export interface PartnerLandlordApplication {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  propertyCount: number;
  propertyLocations: string;
  status: PartnerApplicationStatus;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePartnerLandlordApplicationData {
  fullName: string;
  phone: string;
  email: string;
  propertyCount: number;
  propertyLocations: string;
}

export interface PartnerLandlordApplicationUpdate {
  status?: PartnerApplicationStatus;
  notes?: string;
  reviewedBy: string;
}

export interface PartnerLandlordApplicationListResult {
  applications: PartnerLandlordApplication[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PartnerLandlordApplicationStore {
  create(
    data: CreatePartnerLandlordApplicationData,
  ): Promise<PartnerLandlordApplication>;
  /** Most recent application for this email created at or after `since`. */
  findRecentByEmail(
    email: string,
    since: Date,
  ): Promise<PartnerLandlordApplication | null>;
  list(filters?: {
    status?: PartnerApplicationStatus;
    page?: number;
    pageSize?: number;
  }): Promise<PartnerLandlordApplicationListResult>;
  update(
    id: string,
    update: PartnerLandlordApplicationUpdate,
  ): Promise<PartnerLandlordApplication | null>;
  clear(): Promise<void>;
}

export class InMemoryPartnerLandlordApplicationStore
  implements PartnerLandlordApplicationStore
{
  private applications = new Map<string, PartnerLandlordApplication>();

  async create(
    data: CreatePartnerLandlordApplicationData,
  ): Promise<PartnerLandlordApplication> {
    const now = new Date();
    const application: PartnerLandlordApplication = {
      id: `PLA-${randomUUID()}`,
      ...data,
      status: "pending",
      reviewedBy: null,
      reviewedAt: null,
      notes: null,
      createdAt: now,
      updatedAt: now,
    };
    this.applications.set(application.id, application);
    return application;
  }

  async findRecentByEmail(
    email: string,
    since: Date,
  ): Promise<PartnerLandlordApplication | null> {
    const target = email.toLowerCase();
    const matches = [...this.applications.values()]
      .filter(
        (a) =>
          a.email.toLowerCase() === target &&
          a.createdAt.getTime() >= since.getTime(),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matches[0] ?? null;
  }

  async list(
    filters: {
      status?: PartnerApplicationStatus;
      page?: number;
      pageSize?: number;
    } = {},
  ): Promise<PartnerLandlordApplicationListResult> {
    const page = filters.page ?? 1;
    const pageSize = Math.min(filters.pageSize ?? 50, 200);
    const filtered = [...this.applications.values()]
      .filter((a) => !filters.status || a.status === filters.status)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const start = (page - 1) * pageSize;
    return {
      applications: filtered.slice(start, start + pageSize),
      total: filtered.length,
      page,
      pageSize,
    };
  }

  async update(
    id: string,
    update: PartnerLandlordApplicationUpdate,
  ): Promise<PartnerLandlordApplication | null> {
    const existing = this.applications.get(id);
    if (!existing) return null;
    const now = new Date();
    const updated: PartnerLandlordApplication = {
      ...existing,
      status: update.status ?? existing.status,
      notes: update.notes ?? existing.notes,
      reviewedBy: update.reviewedBy,
      reviewedAt: now,
      updatedAt: now,
    };
    this.applications.set(id, updated);
    return updated;
  }

  async clear(): Promise<void> {
    this.applications.clear();
  }
}

type PartnerLandlordApplicationRow = {
  id: string;
  full_name: string;
  phone_number: string;
  email: string;
  property_count: number;
  property_locations: string;
  status: PartnerApplicationStatus;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = `id, full_name, phone_number, email, property_count, property_locations,
  status, reviewed_by, reviewed_at, notes, created_at, updated_at`;

function mapRow(row: PartnerLandlordApplicationRow): PartnerLandlordApplication {
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone_number,
    email: row.email,
    propertyCount: row.property_count,
    propertyLocations: row.property_locations,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresPartnerLandlordApplicationStore
  implements PartnerLandlordApplicationStore
{
  private async pool() {
    const pool = await getPool();
    if (!pool) throw new Error("Database pool not initialized");
    return pool;
  }

  async create(
    data: CreatePartnerLandlordApplicationData,
  ): Promise<PartnerLandlordApplication> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `INSERT INTO partner_landlord_applications
         (id, full_name, phone_number, email, property_count, property_locations)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [
        `PLA-${randomUUID()}`,
        data.fullName,
        data.phone,
        data.email,
        data.propertyCount,
        data.propertyLocations,
      ],
    );
    return mapRow(rows[0] as PartnerLandlordApplicationRow);
  }

  async findRecentByEmail(
    email: string,
    since: Date,
  ): Promise<PartnerLandlordApplication | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM partner_landlord_applications
       WHERE LOWER(email) = LOWER($1) AND created_at >= $2
       ORDER BY created_at DESC LIMIT 1`,
      [email, since],
    );
    return rows[0] ? mapRow(rows[0] as PartnerLandlordApplicationRow) : null;
  }

  async list(
    filters: {
      status?: PartnerApplicationStatus;
      page?: number;
      pageSize?: number;
    } = {},
  ): Promise<PartnerLandlordApplicationListResult> {
    const pool = await this.pool();
    const page = filters.page ?? 1;
    const pageSize = Math.min(filters.pageSize ?? 50, 200);
    const status = filters.status ?? null;

    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM partner_landlord_applications
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [status, pageSize, (page - 1) * pageSize],
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM partner_landlord_applications
       WHERE ($1::text IS NULL OR status = $1)`,
      [status],
    );
    return {
      applications: rows.map((r: unknown) =>
        mapRow(r as PartnerLandlordApplicationRow),
      ),
      total: countRows[0]?.total ?? 0,
      page,
      pageSize,
    };
  }

  async update(
    id: string,
    update: PartnerLandlordApplicationUpdate,
  ): Promise<PartnerLandlordApplication | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `UPDATE partner_landlord_applications
       SET status = COALESCE($2, status),
           notes = COALESCE($3, notes),
           reviewed_by = $4,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, update.status ?? null, update.notes ?? null, update.reviewedBy],
    );
    return rows[0] ? mapRow(rows[0] as PartnerLandlordApplicationRow) : null;
  }

  async clear(): Promise<void> {
    const pool = await this.pool();
    await pool.query("DELETE FROM partner_landlord_applications");
  }
}

let partnerLandlordApplicationStore: PartnerLandlordApplicationStore =
  new InMemoryPartnerLandlordApplicationStore();

export function initPartnerLandlordApplicationStore(
  store: PartnerLandlordApplicationStore,
): void {
  partnerLandlordApplicationStore = store;
}

export { partnerLandlordApplicationStore };
