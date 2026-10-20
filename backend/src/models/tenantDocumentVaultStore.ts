/**
 * Tenant Document Vault Store
 * In-memory and PostgreSQL implementations over tenant_documents
 * (migrations 025, 036 presign columns, 039 deal linkage + soft delete).
 *
 * Every read is owner-scoped (user_id) and ignores soft-deleted rows. Rows
 * created by the presign flow stay `pending` until the upload is confirmed and
 * are never listed, downloaded or counted until then.
 */

import { getPool } from "../db.js";
import type {
  DocumentCategory,
  TenantDocumentResponse,
} from "../schemas/tenantDocument.js";

export interface CreateDocumentInput {
  fileName: string;
  fileFormat: string;
  fileSizeBytes: number;
  storageKey: string;
  category: DocumentCategory;
  description?: string | null;
  dealId?: string | null;
  isLandlordUploaded?: boolean;
  readOnly?: boolean;
}

export interface CreatePendingUploadInput {
  docType: string;
  contentType: string;
  objectKey: string;
  category: DocumentCategory;
  description?: string | null;
  dealId?: string | null;
}

export interface ConfirmUploadInput {
  fileName: string;
  fileFormat: string;
  fileSizeBytes: number;
}

export interface ListDocumentsFilters {
  category?: DocumentCategory;
  dealId?: string;
  /** Case-insensitive match on file name or description. */
  search?: string;
  page: number;
  pageSize: number;
}

/** Internal view of a row, including fields the API never returns. */
export interface TenantDocumentRecord extends TenantDocumentResponse {
  storageKey: string;
  contentType: string | null;
  uploadStatus: "pending" | "confirmed";
  readOnly: boolean;
}

export interface TenantDocumentVaultStore {
  create(userId: string, input: CreateDocumentInput): Promise<TenantDocumentResponse>;
  createPendingUpload(
    userId: string,
    input: CreatePendingUploadInput,
  ): Promise<TenantDocumentRecord>;
  findPendingByObjectKey(
    objectKey: string,
    userId: string,
  ): Promise<TenantDocumentRecord | null>;
  confirmUpload(
    id: string,
    userId: string,
    input: ConfirmUploadInput,
  ): Promise<TenantDocumentResponse | null>;
  /** Confirmed, non-deleted document owned by `userId`. */
  findById(id: string, userId: string): Promise<TenantDocumentRecord | null>;
  list(
    userId: string,
    filters: ListDocumentsFilters,
  ): Promise<{ documents: TenantDocumentResponse[]; total: number }>;
  /** Soft-deletes a document; returns its storage key when something was deleted. */
  delete(id: string, userId: string): Promise<{ storageKey: string | null; deleted: boolean }>;
  getTotalStorageBytes(userId: string): Promise<number>;
}

function toResponse(record: TenantDocumentRecord): TenantDocumentResponse {
  return {
    id: record.id,
    userId: record.userId,
    fileName: record.fileName,
    fileFormat: record.fileFormat,
    fileSizeBytes: record.fileSizeBytes,
    category: record.category,
    description: record.description,
    dealId: record.dealId,
    isLandlordUploaded: record.isLandlordUploaded,
    createdAt: record.createdAt,
  };
}

/**
 * In-memory implementation for testing
 */
export class InMemoryTenantDocumentVaultStore implements TenantDocumentVaultStore {
  private documents = new Map<string, TenantDocumentRecord & { deletedAt: string | null }>();
  private counter = 1;

  private nextId(): string {
    return `DOC-${Date.now()}-${this.counter++}`;
  }

  async create(userId: string, input: CreateDocumentInput): Promise<TenantDocumentResponse> {
    const record = {
      id: this.nextId(),
      userId,
      fileName: input.fileName,
      fileFormat: input.fileFormat,
      fileSizeBytes: input.fileSizeBytes,
      category: input.category,
      description: input.description ?? null,
      dealId: input.dealId ?? null,
      isLandlordUploaded: input.isLandlordUploaded ?? false,
      createdAt: new Date().toISOString(),
      storageKey: input.storageKey,
      contentType: null,
      uploadStatus: "confirmed" as const,
      readOnly: input.readOnly ?? false,
      deletedAt: null,
    };
    this.documents.set(record.id, record);
    return toResponse(record);
  }

  async createPendingUpload(
    userId: string,
    input: CreatePendingUploadInput,
  ): Promise<TenantDocumentRecord> {
    const record = {
      id: this.nextId(),
      userId,
      fileName: "",
      fileFormat: "",
      fileSizeBytes: 0,
      category: input.category,
      description: input.description ?? null,
      dealId: input.dealId ?? null,
      isLandlordUploaded: false,
      createdAt: new Date().toISOString(),
      storageKey: input.objectKey,
      contentType: input.contentType,
      uploadStatus: "pending" as const,
      readOnly: false,
      deletedAt: null,
    };
    this.documents.set(record.id, record);
    return { ...record };
  }

  async findPendingByObjectKey(
    objectKey: string,
    userId: string,
  ): Promise<TenantDocumentRecord | null> {
    for (const doc of this.documents.values()) {
      if (
        doc.storageKey === objectKey &&
        doc.userId === userId &&
        doc.uploadStatus === "pending" &&
        !doc.deletedAt
      ) {
        return { ...doc };
      }
    }
    return null;
  }

  async confirmUpload(
    id: string,
    userId: string,
    input: ConfirmUploadInput,
  ): Promise<TenantDocumentResponse | null> {
    const doc = this.documents.get(id);
    if (!doc || doc.userId !== userId || doc.uploadStatus !== "pending" || doc.deletedAt) {
      return null;
    }
    Object.assign(doc, {
      fileName: input.fileName,
      fileFormat: input.fileFormat,
      fileSizeBytes: input.fileSizeBytes,
      uploadStatus: "confirmed",
    });
    return toResponse(doc);
  }

  async findById(id: string, userId: string): Promise<TenantDocumentRecord | null> {
    const doc = this.documents.get(id);
    if (!doc || doc.userId !== userId || doc.deletedAt || doc.uploadStatus !== "confirmed") {
      return null;
    }
    return { ...doc };
  }

  async list(
    userId: string,
    filters: ListDocumentsFilters,
  ): Promise<{ documents: TenantDocumentResponse[]; total: number }> {
    const search = filters.search?.toLowerCase();
    const matches = [...this.documents.values()]
      .filter(
        (d) =>
          d.userId === userId &&
          !d.deletedAt &&
          d.uploadStatus === "confirmed" &&
          (!filters.category || d.category === filters.category) &&
          (!filters.dealId || d.dealId === filters.dealId) &&
          (!search ||
            d.fileName.toLowerCase().includes(search) ||
            (d.description ?? "").toLowerCase().includes(search)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const start = (filters.page - 1) * filters.pageSize;
    return {
      documents: matches.slice(start, start + filters.pageSize).map(toResponse),
      total: matches.length,
    };
  }

  async delete(
    id: string,
    userId: string,
  ): Promise<{ storageKey: string | null; deleted: boolean }> {
    const doc = this.documents.get(id);
    if (!doc || doc.userId !== userId || doc.deletedAt) {
      return { storageKey: null, deleted: false };
    }
    doc.deletedAt = new Date().toISOString();
    return { storageKey: doc.storageKey, deleted: true };
  }

  async getTotalStorageBytes(userId: string): Promise<number> {
    let total = 0;
    for (const doc of this.documents.values()) {
      if (doc.userId === userId && !doc.deletedAt && doc.uploadStatus === "confirmed") {
        total += doc.fileSizeBytes;
      }
    }
    return total;
  }

  async clear(): Promise<void> {
    this.documents.clear();
    this.counter = 1;
  }
}

const RECORD_COLUMNS = `id, user_id, file_name, file_format, file_size_bytes, category,
  description, deal_id, is_landlord_uploaded, created_at, storage_key, content_type,
  upload_status, read_only`;

function rowToRecord(row: any): TenantDocumentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    fileName: row.file_name ?? "",
    fileFormat: row.file_format ?? "",
    fileSizeBytes: row.file_size_bytes ?? 0,
    category: row.category,
    description: row.description,
    dealId: row.deal_id,
    isLandlordUploaded: row.is_landlord_uploaded,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    storageKey: row.storage_key,
    contentType: row.content_type ?? null,
    uploadStatus: row.upload_status,
    readOnly: row.read_only,
  };
}

/**
 * PostgreSQL implementation
 */
export class PostgresTenantDocumentVaultStore implements TenantDocumentVaultStore {
  private async pool() {
    const pool = await getPool();
    if (!pool) throw new Error("Database not configured");
    return pool;
  }

  async create(userId: string, input: CreateDocumentInput): Promise<TenantDocumentResponse> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `INSERT INTO tenant_documents (
        user_id, file_name, file_format, file_size_bytes, storage_key, category,
        description, deal_id, is_landlord_uploaded, read_only, upload_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed')
      RETURNING ${RECORD_COLUMNS}`,
      [
        userId,
        input.fileName,
        input.fileFormat,
        input.fileSizeBytes,
        input.storageKey,
        input.category,
        input.description ?? null,
        input.dealId ?? null,
        input.isLandlordUploaded ?? false,
        input.readOnly ?? false,
      ],
    );
    return toResponse(rowToRecord(rows[0]));
  }

  async createPendingUpload(
    userId: string,
    input: CreatePendingUploadInput,
  ): Promise<TenantDocumentRecord> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `INSERT INTO tenant_documents (
        user_id, storage_key, category, description, deal_id, doc_type, content_type, upload_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      RETURNING ${RECORD_COLUMNS}`,
      [
        userId,
        input.objectKey,
        input.category,
        input.description ?? null,
        input.dealId ?? null,
        input.docType,
        input.contentType,
      ],
    );
    return rowToRecord(rows[0]);
  }

  async findPendingByObjectKey(
    objectKey: string,
    userId: string,
  ): Promise<TenantDocumentRecord | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `SELECT ${RECORD_COLUMNS} FROM tenant_documents
       WHERE storage_key = $1 AND user_id = $2 AND upload_status = 'pending' AND deleted_at IS NULL`,
      [objectKey, userId],
    );
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async confirmUpload(
    id: string,
    userId: string,
    input: ConfirmUploadInput,
  ): Promise<TenantDocumentResponse | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `UPDATE tenant_documents
       SET file_name = $3, file_format = $4, file_size_bytes = $5,
           upload_status = 'confirmed', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND upload_status = 'pending' AND deleted_at IS NULL
       RETURNING ${RECORD_COLUMNS}`,
      [id, userId, input.fileName, input.fileFormat, input.fileSizeBytes],
    );
    return rows[0] ? toResponse(rowToRecord(rows[0])) : null;
  }

  async findById(id: string, userId: string): Promise<TenantDocumentRecord | null> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `SELECT ${RECORD_COLUMNS} FROM tenant_documents
       WHERE id = $1 AND user_id = $2 AND upload_status = 'confirmed' AND deleted_at IS NULL`,
      [id, userId],
    );
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async list(
    userId: string,
    filters: ListDocumentsFilters,
  ): Promise<{ documents: TenantDocumentResponse[]; total: number }> {
    const pool = await this.pool();
    const conditions = ["user_id = $1", "deleted_at IS NULL", "upload_status = 'confirmed'"];
    const params: unknown[] = [userId];

    if (filters.category) {
      params.push(filters.category);
      conditions.push(`category = $${params.length}`);
    }
    if (filters.dealId) {
      params.push(filters.dealId);
      conditions.push(`deal_id = $${params.length}`);
    }
    if (filters.search) {
      // Escape LIKE wildcards so the search is a plain substring match.
      params.push(`%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      conditions.push(
        `(file_name ILIKE $${params.length} OR COALESCE(description, '') ILIKE $${params.length})`,
      );
    }

    const where = conditions.join(" AND ");
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM tenant_documents WHERE ${where}`,
      params,
    );
    const dataResult = await pool.query(
      `SELECT ${RECORD_COLUMNS} FROM tenant_documents WHERE ${where}
       ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
    );
    return {
      documents: dataResult.rows.map((row) => toResponse(rowToRecord(row))),
      total: countResult.rows[0].total,
    };
  }

  async delete(
    id: string,
    userId: string,
  ): Promise<{ storageKey: string | null; deleted: boolean }> {
    const pool = await this.pool();
    const { rows, rowCount } = await pool.query(
      `UPDATE tenant_documents SET deleted_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING storage_key`,
      [id, userId],
    );
    if ((rowCount ?? 0) === 0) return { storageKey: null, deleted: false };
    return { storageKey: rows[0].storage_key, deleted: true };
  }

  async getTotalStorageBytes(userId: string): Promise<number> {
    const pool = await this.pool();
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(file_size_bytes), 0)::int AS total FROM tenant_documents
       WHERE user_id = $1 AND deleted_at IS NULL AND upload_status = 'confirmed'`,
      [userId],
    );
    return rows[0].total ?? 0;
  }
}

// Singleton instance
let tenantDocumentVaultStore: TenantDocumentVaultStore =
  new InMemoryTenantDocumentVaultStore();

export function initTenantDocumentVaultStore(store: TenantDocumentVaultStore): void {
  tenantDocumentVaultStore = store;
}

export function getTenantDocumentVaultStore(): TenantDocumentVaultStore {
  return tenantDocumentVaultStore;
}
