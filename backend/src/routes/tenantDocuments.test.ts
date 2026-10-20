import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";

const { currentUser, storage, audit } = vi.hoisted(() => ({
  currentUser: { id: "tenant-1" },
  storage: {
    generatePresignedUpload: vi.fn(),
    generatePresignedDownload: vi.fn(),
    deleteFile: vi.fn(),
  },
  audit: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: currentUser.id };
    next();
  },
}));

vi.mock("../services/storageService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/storageService.js")>()),
  generatePresignedUpload: storage.generatePresignedUpload,
  generatePresignedDownload: storage.generatePresignedDownload,
  deleteFile: storage.deleteFile,
}));

vi.mock("../utils/auditLogger.js", () => ({
  auditLog: audit,
  extractAuditContext: (req: any) => ({
    userId: req.user?.userId,
    requestId: "req-1",
    ip: "127.0.0.1",
    actorType: "user",
  }),
}));

import { createTenantDocumentsRouter } from "./tenantDocuments.js";
import {
  InMemoryTenantDocumentVaultStore,
  initTenantDocumentVaultStore,
} from "../models/tenantDocumentVaultStore.js";
import { errorHandler } from "../middleware/errorHandler.js";

const BASE = "/api/v1/tenant/documents";

describe("Tenant documents routes (#1906)", () => {
  let app: express.Application;
  let store: InMemoryTenantDocumentVaultStore;

  async function seed(userId: string, overrides: Record<string, unknown> = {}) {
    return store.create(userId, {
      fileName: "payslip.pdf",
      fileFormat: "pdf",
      fileSizeBytes: 2048,
      storageKey: `tenant-documents/${userId}/other/${Math.random()}.pdf`,
      category: "payment_receipt",
      ...overrides,
    } as any);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    currentUser.id = "tenant-1";
    store = new InMemoryTenantDocumentVaultStore();
    initTenantDocumentVaultStore(store);
    storage.generatePresignedUpload.mockResolvedValue({
      uploadUrl: "https://storage.test/upload",
      expiresAt: "2026-10-18T00:15:00.000Z",
    });
    storage.generatePresignedDownload.mockResolvedValue({
      downloadUrl: "https://storage.test/download?sig=abc",
      expiresAt: "2026-10-18T00:15:00.000Z",
    });
    storage.deleteFile.mockResolvedValue(undefined);

    app = express();
    app.use(express.json());
    app.use(BASE, createTenantDocumentsRouter());
    app.use(errorHandler);
  });

  describe("GET /", () => {
    it("returns the caller's documents in the shape the documents page expects", async () => {
      await seed("tenant-1", { fileName: "lease.pdf", category: "lease_agreement" });
      await seed("tenant-2");

      const res = await request(app).get(BASE).expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toEqual({
        id: expect.any(String),
        userId: "tenant-1",
        fileName: "lease.pdf",
        fileFormat: "pdf",
        fileSizeBytes: 2048,
        category: "lease_agreement",
        description: null,
        dealId: null,
        isLandlordUploaded: false,
        createdAt: expect.any(String),
      });
      expect(res.body.data[0]).not.toHaveProperty("storageKey");
      expect(res.body.pagination).toEqual({ page: 1, pageSize: 20, total: 1, totalPages: 1 });
    });

    it("filters by category, dealId and search", async () => {
      await seed("tenant-1", { fileName: "march-payslip.pdf", category: "payment_receipt" });
      await seed("tenant-1", { fileName: "passport.png", category: "identity_document" });
      await seed("tenant-1", { fileName: "lease.pdf", category: "lease_agreement", dealId: "deal-9" });

      const byCategory = await request(app).get(`${BASE}?category=identity_document`).expect(200);
      expect(byCategory.body.data.map((d: any) => d.fileName)).toEqual(["passport.png"]);

      const byDeal = await request(app).get(`${BASE}?dealId=deal-9`).expect(200);
      expect(byDeal.body.data.map((d: any) => d.fileName)).toEqual(["lease.pdf"]);

      const bySearch = await request(app).get(`${BASE}?search=PAYSLIP`).expect(200);
      expect(bySearch.body.data.map((d: any) => d.fileName)).toEqual(["march-payslip.pdf"]);
    });

    it("paginates", async () => {
      for (let i = 0; i < 5; i++) await seed("tenant-1");

      const res = await request(app).get(`${BASE}?page=2&pageSize=2`).expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination).toEqual({ page: 2, pageSize: 2, total: 5, totalPages: 3 });
    });

    it("rejects an unknown category", async () => {
      await request(app).get(`${BASE}?category=selfie`).expect(400);
    });
  });

  describe("presigned upload", () => {
    it("issues an upload URL under the caller's prefix and confirms the upload", async () => {
      const presign = await request(app)
        .post(`${BASE}/presign`)
        .send({ docType: "passport", contentType: "application/pdf" })
        .expect(201);

      const { documentId, objectKey, uploadUrl } = presign.body.data;
      expect(uploadUrl).toBe("https://storage.test/upload");
      expect(objectKey).toMatch(/^tenant-documents\/tenant-1\/passport\/.+\.pdf$/);
      expect(audit).toHaveBeenCalledWith(
        "DOCUMENT_UPLOAD_URL_ISSUED",
        expect.anything(),
        expect.objectContaining({ documentId }),
      );

      // Pending uploads are not listed until confirmed.
      expect((await request(app).get(BASE)).body.data).toHaveLength(0);

      const confirm = await request(app)
        .post(BASE)
        .send({ objectKey, fileName: "passport.pdf", fileSizeBytes: 4096 })
        .expect(201);

      expect(confirm.body.data).toMatchObject({
        id: documentId,
        fileName: "passport.pdf",
        fileFormat: "pdf",
        fileSizeBytes: 4096,
        category: "identity_document",
      });
      expect((await request(app).get(BASE)).body.data).toHaveLength(1);
      expect(audit).toHaveBeenCalledWith(
        "DOCUMENT_UPLOAD_CONFIRMED",
        expect.anything(),
        expect.objectContaining({ documentId }),
      );
    });

    it("rejects disallowed content types and unknown doc types", async () => {
      await request(app)
        .post(`${BASE}/presign`)
        .send({ docType: "passport", contentType: "application/x-msdownload" })
        .expect(400);
      await request(app)
        .post(`${BASE}/presign`)
        .send({ docType: "selfie", contentType: "image/png" })
        .expect(400);
      expect(storage.generatePresignedUpload).not.toHaveBeenCalled();
    });

    it("cannot confirm another user's pending upload", async () => {
      const presign = await request(app)
        .post(`${BASE}/presign`)
        .send({ docType: "id_card", contentType: "image/png" })
        .expect(201);

      currentUser.id = "tenant-2";
      await request(app)
        .post(BASE)
        .send({ objectKey: presign.body.data.objectKey, fileSizeBytes: 100 })
        .expect(404);
    });

    it("requires a size and enforces the 20 MB limit on confirm", async () => {
      const presign = await request(app)
        .post(`${BASE}/presign`)
        .send({ docType: "bank_statement", contentType: "application/pdf" })
        .expect(201);
      const { objectKey } = presign.body.data;

      await request(app).post(BASE).send({ objectKey }).expect(400);
      await request(app)
        .post(BASE)
        .send({ objectKey, fileSizeBytes: 20 * 1024 * 1024 + 1 })
        .expect(400);
    });
  });

  describe("DELETE /:id", () => {
    it("deletes the caller's document, removes the object and audits it", async () => {
      const doc = await seed("tenant-1");

      const res = await request(app).delete(`${BASE}/${doc.id}`).expect(200);

      expect(res.body).toEqual({ success: true, data: { documentId: doc.id, deleted: true } });
      expect((await request(app).get(BASE)).body.data).toHaveLength(0);
      expect(storage.deleteFile).toHaveBeenCalledOnce();
      expect(audit).toHaveBeenCalledWith(
        "DOCUMENT_DELETED",
        expect.anything(),
        { documentId: doc.id },
      );
    });

    it("returns 404 for another user's document and leaves it intact", async () => {
      const doc = await seed("tenant-2");

      await request(app).delete(`${BASE}/${doc.id}`).expect(404);

      currentUser.id = "tenant-2";
      expect((await request(app).get(BASE)).body.data).toHaveLength(1);
      expect(storage.deleteFile).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it("refuses to delete a read-only lease provided by the landlord", async () => {
      const doc = await seed("tenant-1", { isLandlordUploaded: true, readOnly: true });

      await request(app).delete(`${BASE}/${doc.id}`).expect(403);
      expect((await request(app).get(BASE)).body.data).toHaveLength(1);
    });
  });

  describe("GET /:id/download", () => {
    it("returns a short-lived URL for the caller's document and audits it", async () => {
      const doc = await seed("tenant-1");

      const res = await request(app).get(`${BASE}/${doc.id}/download`).expect(200);

      expect(res.body).toEqual({
        success: true,
        data: {
          documentId: doc.id,
          downloadUrl: "https://storage.test/download?sig=abc",
          expiresInSeconds: 900,
        },
      });
      expect(storage.generatePresignedDownload).toHaveBeenCalledWith(expect.any(String), 900);
      expect(audit).toHaveBeenCalledWith(
        "DOCUMENT_DOWNLOAD_URL_ISSUED",
        expect.anything(),
        expect.objectContaining({ documentId: doc.id }),
      );
    });

    it("returns 404 for another user's document", async () => {
      const doc = await seed("tenant-2");

      await request(app).get(`${BASE}/${doc.id}/download`).expect(404);
      expect(storage.generatePresignedDownload).not.toHaveBeenCalled();
    });

    it("returns 404 once the document is deleted", async () => {
      const doc = await seed("tenant-1");
      await request(app).delete(`${BASE}/${doc.id}`).expect(200);

      await request(app).get(`${BASE}/${doc.id}/download`).expect(404);
    });
  });
});
