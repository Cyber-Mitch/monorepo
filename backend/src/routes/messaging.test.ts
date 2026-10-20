import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { v4 as randomUUID } from "uuid";
import { createMessagingRouter } from "./messaging.js";
import {
  InMemoryMessagingStore,
  initMessagingStore,
} from "../models/messagingStore.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";

const { storageMocks, auditLogMock } = vi.hoisted(() => ({
  storageMocks: {
    generatePresignedUpload: vi.fn(),
    generatePresignedDownload: vi.fn(),
    headFile: vi.fn(),
    deleteFile: vi.fn(),
  },
  auditLogMock: vi.fn(),
}));

// Keep the real key builders; mock everything that touches storage.
vi.mock("../services/storageService.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/storageService.js")>();
  return { ...actual, ...storageMocks };
});

vi.mock("../utils/auditLogger.js", () => ({
  auditLog: auditLogMock,
  extractAuditContext: vi.fn(() => ({
    userId: "test",
    requestId: "req-1",
    ip: "127.0.0.1",
    actorType: "user",
  })),
}));

// Authenticated user comes from the x-test-user header; missing header → 401.
vi.mock("../middleware/auth.js", async () => {
  const { AppError } = await import("../errors/AppError.js");
  const { ErrorCode } = await import("../errors/errorCodes.js");
  return {
    authenticateToken: (req: any, _res: any, next: any) => {
      const id = req.headers["x-test-user"];
      if (!id) {
        return next(
          new AppError(ErrorCode.UNAUTHORIZED, 401, "Authentication required"),
        );
      }
      req.user = { id, email: `${id}@example.com`, name: id, role: "tenant" };
      next();
    },
  };
});

const ALICE = "user-alice";
const BOB = "user-bob";
const MALLORY = "user-mallory";
const MB = 1024 * 1024;

describe("Messaging routes", () => {
  let app: express.Application;
  let store: InMemoryMessagingStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    store = new InMemoryMessagingStore();
    initMessagingStore(store);

    storageMocks.generatePresignedUpload.mockImplementation(
      async (key: string, _ct: string, ttl: number) => ({
        uploadUrl: `https://s3.local/upload/${key}?X-Amz-Expires=${ttl}`,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      }),
    );
    storageMocks.generatePresignedDownload.mockImplementation(
      async (key: string, ttl: number) => ({
        downloadUrl: `https://s3.local/download/${key}?X-Amz-Expires=${ttl}`,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      }),
    );
    storageMocks.headFile.mockResolvedValue(null);
    storageMocks.deleteFile.mockResolvedValue(undefined);

    app = express();
    app.use(requestIdMiddleware);
    app.use(express.json());
    app.use("/api/v1/messaging", createMessagingRouter());
    app.use(errorHandler);
  });

  async function createConversation(
    as = ALICE,
    participantIds = [BOB],
  ): Promise<string> {
    const res = await request(app)
      .post("/api/v1/messaging/conversations")
      .set("x-test-user", as)
      .send({ participantIds })
      .expect(201);
    return res.body.data.id as string;
  }

  async function presign(
    conversationId: string,
    body: Record<string, unknown> = {
      fileName: "lease scan.pdf",
      contentType: "application/pdf",
      size: 2 * MB,
    },
    as = ALICE,
  ) {
    return request(app)
      .post(`/api/v1/messaging/conversations/${conversationId}/attachments/presign`)
      .set("x-test-user", as)
      .send(body);
  }

  async function sendAttachmentMessage(
    conversationId: string,
    attachment: Record<string, unknown>,
    as = ALICE,
  ) {
    return request(app)
      .post(`/api/v1/messaging/conversations/${conversationId}/messages`)
      .set("x-test-user", as)
      .send({ body: "see attached", attachment });
  }

  /** Presign + simulate a successful upload of a PDF; returns the attachment. */
  async function uploadedAttachment(conversationId: string, size = 2 * MB) {
    const res = await presign(conversationId, {
      fileName: "lease.pdf",
      contentType: "application/pdf",
      size,
    });
    expect(res.status).toBe(201);
    const objectKey = res.body.data.objectKey as string;
    storageMocks.headFile.mockImplementation(async (key: string) =>
      key === objectKey ? { size, contentType: "application/pdf" } : null,
    );
    return { objectKey, fileName: "lease.pdf", contentType: "application/pdf", size };
  }

  // ── Minimal messaging core (#1896 subset) ─────────────────────────────────

  describe("conversations", () => {
    it("requires authentication", async () => {
      await request(app).get("/api/v1/messaging/conversations").expect(401);
    });

    it("creates a conversation including the caller as admin", async () => {
      const res = await request(app)
        .post("/api/v1/messaging/conversations")
        .set("x-test-user", ALICE)
        .send({ participantIds: [BOB, ALICE], subjectType: "deal", subjectId: "deal-1" })
        .expect(201);

      expect(res.body.data.subjectType).toBe("deal");
      expect(res.body.data.subjectId).toBe("deal-1");
      const participants = res.body.data.participants as Array<{
        userId: string;
        role: string;
      }>;
      expect(participants).toHaveLength(2);
      expect(participants.find((p) => p.userId === ALICE)?.role).toBe("admin");
      expect(participants.find((p) => p.userId === BOB)?.role).toBe("member");
    });

    it("rejects a conversation with no other participants", async () => {
      await request(app)
        .post("/api/v1/messaging/conversations")
        .set("x-test-user", ALICE)
        .send({ participantIds: [ALICE] })
        .expect(400);
      await request(app)
        .post("/api/v1/messaging/conversations")
        .set("x-test-user", ALICE)
        .send({ participantIds: [] })
        .expect(400);
    });

    it("lists only conversations the caller participates in", async () => {
      const ab = await createConversation(ALICE, [BOB]);
      const bm = await createConversation(BOB, [MALLORY]);

      const alice = await request(app)
        .get("/api/v1/messaging/conversations")
        .set("x-test-user", ALICE)
        .expect(200);
      expect(alice.body.data.map((c: { id: string }) => c.id)).toEqual([ab]);

      const bob = await request(app)
        .get("/api/v1/messaging/conversations")
        .set("x-test-user", BOB)
        .expect(200);
      expect(bob.body.data.map((c: { id: string }) => c.id).sort()).toEqual(
        [ab, bm].sort(),
      );
    });
  });

  describe("messages", () => {
    it("lets participants send and list messages, newest first", async () => {
      const id = await createConversation();
      await request(app)
        .post(`/api/v1/messaging/conversations/${id}/messages`)
        .set("x-test-user", ALICE)
        .send({ body: "hello" })
        .expect(201);
      await new Promise((r) => setTimeout(r, 2));
      const reply = await request(app)
        .post(`/api/v1/messaging/conversations/${id}/messages`)
        .set("x-test-user", BOB)
        .send({ body: "hi back" })
        .expect(201);
      expect(reply.body.data.senderId).toBe(BOB);

      const list = await request(app)
        .get(`/api/v1/messaging/conversations/${id}/messages`)
        .set("x-test-user", ALICE)
        .expect(200);
      expect(list.body.data.map((m: { body: string }) => m.body)).toEqual([
        "hi back",
        "hello",
      ]);
    });

    it("rejects an empty message without attachment", async () => {
      const id = await createConversation();
      await request(app)
        .post(`/api/v1/messaging/conversations/${id}/messages`)
        .set("x-test-user", ALICE)
        .send({ body: "   " })
        .expect(400);
    });

    it("returns 403 to non-participants for list and send", async () => {
      const id = await createConversation();
      await request(app)
        .get(`/api/v1/messaging/conversations/${id}/messages`)
        .set("x-test-user", MALLORY)
        .expect(403);
      await request(app)
        .post(`/api/v1/messaging/conversations/${id}/messages`)
        .set("x-test-user", MALLORY)
        .send({ body: "let me in" })
        .expect(403);
    });

    it("returns 404 for an unknown conversation and 400 for a malformed id", async () => {
      await request(app)
        .get(`/api/v1/messaging/conversations/${randomUUID()}/messages`)
        .set("x-test-user", ALICE)
        .expect(404);
      await request(app)
        .get(`/api/v1/messaging/conversations/not-a-uuid/messages`)
        .set("x-test-user", ALICE)
        .expect(400);
    });

    it("soft-deletes the sender's own message and hides it from the list", async () => {
      const id = await createConversation();
      const sent = await request(app)
        .post(`/api/v1/messaging/conversations/${id}/messages`)
        .set("x-test-user", ALICE)
        .send({ body: "oops" })
        .expect(201);
      const messageId = sent.body.data.id;

      const del = await request(app)
        .delete(`/api/v1/messaging/messages/${messageId}`)
        .set("x-test-user", ALICE)
        .expect(200);
      expect(del.body.data.deletedAt).toBeTruthy();
      expect(storageMocks.deleteFile).not.toHaveBeenCalled();

      const list = await request(app)
        .get(`/api/v1/messaging/conversations/${id}/messages`)
        .set("x-test-user", BOB)
        .expect(200);
      expect(list.body.data).toHaveLength(0);

      // Already deleted → 404
      await request(app)
        .delete(`/api/v1/messaging/messages/${messageId}`)
        .set("x-test-user", ALICE)
        .expect(404);
      expect(auditLogMock).toHaveBeenCalledWith(
        "MESSAGE_DELETED",
        expect.anything(),
        expect.objectContaining({ messageId, hadAttachment: false }),
      );
    });

    it("only lets the sender delete a message", async () => {
      const id = await createConversation();
      const sent = await request(app)
        .post(`/api/v1/messaging/conversations/${id}/messages`)
        .set("x-test-user", ALICE)
        .send({ body: "mine" })
        .expect(201);

      await request(app)
        .delete(`/api/v1/messaging/messages/${sent.body.data.id}`)
        .set("x-test-user", BOB)
        .expect(403);
      await request(app)
        .delete(`/api/v1/messaging/messages/${sent.body.data.id}`)
        .set("x-test-user", MALLORY)
        .expect(403);
      await request(app)
        .delete(`/api/v1/messaging/messages/${randomUUID()}`)
        .set("x-test-user", ALICE)
        .expect(404);
    });
  });

  // ── Attachments (#1898) ───────────────────────────────────────────────────

  describe("POST /conversations/:id/attachments/presign", () => {
    it("issues an upload URL scoped to the conversation prefix", async () => {
      const id = await createConversation();
      const res = await presign(id);

      expect(res.status).toBe(201);
      const { uploadUrl, objectKey, expiresAt } = res.body.data;
      expect(uploadUrl).toContain(objectKey);
      expect(expiresAt).toBeTruthy();
      expect(objectKey).toMatch(
        new RegExp(`^messaging/${id}/[0-9a-f-]{36}-lease_scan\\.pdf$`),
      );
      expect(storageMocks.generatePresignedUpload).toHaveBeenCalledWith(
        objectKey,
        "application/pdf",
        expect.any(Number),
      );
      expect(auditLogMock).toHaveBeenCalledWith(
        "MESSAGE_ATTACHMENT_UPLOAD_URL_ISSUED",
        expect.anything(),
        expect.objectContaining({ conversationId: id, objectKey }),
      );
    });

    it("sanitizes path traversal in the file name", async () => {
      const id = await createConversation();
      const res = await presign(id, {
        fileName: "../../other/../evil name.png",
        contentType: "image/png",
        size: 100,
      });
      expect(res.status).toBe(201);
      const key = res.body.data.objectKey as string;
      expect(key.startsWith(`messaging/${id}/`)).toBe(true);
      expect(key).not.toContain("..");
      expect(key.slice(`messaging/${id}/`.length)).not.toContain("/");
    });

    it.each(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"])(
      "allows %s",
      async (contentType) => {
        const id = await createConversation();
        const res = await presign(id, { fileName: "f", contentType, size: 10 });
        expect(res.status).toBe(201);
      },
    );

    it.each([
      "image/svg+xml",
      "text/html",
      "application/zip",
      "application/x-msdownload",
      "video/mp4",
    ])("rejects disallowed type %s with 400", async (contentType) => {
      const id = await createConversation();
      const res = await presign(id, { fileName: "f", contentType, size: 10 });
      expect(res.status).toBe(400);
      expect(storageMocks.generatePresignedUpload).not.toHaveBeenCalled();
    });

    it("rejects sizes over 10 MB and non-positive sizes with 400", async () => {
      const id = await createConversation();
      expect(
        (await presign(id, { fileName: "f.pdf", contentType: "application/pdf", size: 10 * MB + 1 })).status,
      ).toBe(400);
      expect(
        (await presign(id, { fileName: "f.pdf", contentType: "application/pdf", size: 0 })).status,
      ).toBe(400);
      expect(
        (await presign(id, { fileName: "f.pdf", contentType: "application/pdf", size: 10 * MB })).status,
      ).toBe(201);
    });

    it("returns 403 to non-participants and 404 for unknown conversations", async () => {
      const id = await createConversation();
      expect((await presign(id, undefined, MALLORY)).status).toBe(403);
      expect((await presign(randomUUID())).status).toBe(404);
      expect(storageMocks.generatePresignedUpload).not.toHaveBeenCalled();
    });
  });

  describe("sending a message with an attachment", () => {
    it("accepts an uploaded attachment from this conversation", async () => {
      const id = await createConversation();
      const attachment = await uploadedAttachment(id);

      const res = await sendAttachmentMessage(id, attachment);
      expect(res.status).toBe(201);
      expect(res.body.data.attachment).toEqual(attachment);
      expect(storageMocks.headFile).toHaveBeenCalledWith(attachment.objectKey);
    });

    it("allows an attachment-only message", async () => {
      const id = await createConversation();
      const attachment = await uploadedAttachment(id);
      const res = await request(app)
        .post(`/api/v1/messaging/conversations/${id}/messages`)
        .set("x-test-user", ALICE)
        .send({ attachment });
      expect(res.status).toBe(201);
      expect(res.body.data.body).toBe("");
    });

    it("rejects a key presigned for another conversation", async () => {
      const mine = await createConversation(ALICE, [BOB]);
      const other = await createConversation(ALICE, [MALLORY]);
      const attachment = await uploadedAttachment(other);

      const res = await sendAttachmentMessage(mine, attachment);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/does not belong/);
      expect(storageMocks.headFile).not.toHaveBeenCalled();
    });

    it.each([
      (id: string) => `messaging/${id}/../other/${randomUUID()}-x.pdf`,
      (id: string) => `messaging/${id}/nested/${randomUUID()}-x.pdf`,
      (id: string) => `messaging/${id}/not-a-uuid-x.pdf`,
      (id: string) => `tenant-documents/${id}/${randomUUID()}-x.pdf`,
      (id: string) => `messaging/${id}x/${randomUUID()}-x.pdf`,
    ])("rejects forged key %#", async (makeKey) => {
      const id = await createConversation();
      const objectKey = makeKey(id);
      storageMocks.headFile.mockResolvedValue({ size: 10, contentType: "application/pdf" });
      const res = await sendAttachmentMessage(id, {
        objectKey,
        fileName: "x.pdf",
        contentType: "application/pdf",
        size: 10,
      });
      expect(res.status).toBe(400);
    });

    it("rejects an attachment that was never uploaded", async () => {
      const id = await createConversation();
      const res = await presign(id);
      storageMocks.headFile.mockResolvedValue(null);

      const send = await sendAttachmentMessage(id, {
        objectKey: res.body.data.objectKey,
        fileName: "lease scan.pdf",
        contentType: "application/pdf",
        size: 2 * MB,
      });
      expect(send.status).toBe(400);
      expect(send.body.error.message).toMatch(/not been uploaded/);
    });

    it("rejects disallowed declared type or size with 400", async () => {
      const id = await createConversation();
      const attachment = await uploadedAttachment(id);

      expect(
        (await sendAttachmentMessage(id, { ...attachment, contentType: "text/html" })).status,
      ).toBe(400);
      expect(
        (await sendAttachmentMessage(id, { ...attachment, size: 10 * MB + 1 })).status,
      ).toBe(400);
    });

    it("rejects when the stored object is larger than 10 MB", async () => {
      const id = await createConversation();
      const attachment = await uploadedAttachment(id, 5 * MB);
      storageMocks.headFile.mockResolvedValue({
        size: 50 * MB,
        contentType: "application/pdf",
      });
      const res = await sendAttachmentMessage(id, attachment);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/10 MB/);
    });

    it("rejects when stored size or content type differ from the declaration", async () => {
      const id = await createConversation();
      const attachment = await uploadedAttachment(id, 1000);

      storageMocks.headFile.mockResolvedValue({ size: 999, contentType: "application/pdf" });
      expect((await sendAttachmentMessage(id, attachment)).status).toBe(400);

      storageMocks.headFile.mockResolvedValue({ size: 1000, contentType: "text/html" });
      expect((await sendAttachmentMessage(id, attachment)).status).toBe(400);
    });

    it("rejects reusing an attachment key that is already on a message", async () => {
      const id = await createConversation();
      const attachment = await uploadedAttachment(id);
      expect((await sendAttachmentMessage(id, attachment)).status).toBe(201);
      expect((await sendAttachmentMessage(id, attachment, BOB)).status).toBe(409);
    });

    it("returns 403 to non-participants even with a valid key", async () => {
      const id = await createConversation();
      const attachment = await uploadedAttachment(id);
      expect((await sendAttachmentMessage(id, attachment, MALLORY)).status).toBe(403);
    });
  });

  describe("GET /messages/:id/attachment", () => {
    async function sentAttachmentMessage() {
      const id = await createConversation();
      const attachment = await uploadedAttachment(id);
      const res = await sendAttachmentMessage(id, attachment);
      expect(res.status).toBe(201);
      return { conversationId: id, messageId: res.body.data.id as string, attachment };
    }

    it("returns a download URL that expires within 5 minutes to participants", async () => {
      const { messageId, attachment } = await sentAttachmentMessage();
      const before = Date.now();

      const res = await request(app)
        .get(`/api/v1/messaging/messages/${messageId}/attachment`)
        .set("x-test-user", BOB)
        .expect(200);

      const [key, ttl] = storageMocks.generatePresignedDownload.mock.calls[0];
      expect(key).toBe(attachment.objectKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
      expect(new Date(res.body.data.expiresAt).getTime() - before).toBeLessThanOrEqual(
        300_000 + 1000,
      );
      expect(res.body.data).toMatchObject({
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        size: attachment.size,
      });
      expect(res.body.data.downloadUrl).toContain(attachment.objectKey);
      expect(auditLogMock).toHaveBeenCalledWith(
        "MESSAGE_ATTACHMENT_DOWNLOAD_URL_ISSUED",
        expect.anything(),
        expect.objectContaining({ messageId }),
      );
    });

    it("returns 403 to non-participants", async () => {
      const { messageId } = await sentAttachmentMessage();
      await request(app)
        .get(`/api/v1/messaging/messages/${messageId}/attachment`)
        .set("x-test-user", MALLORY)
        .expect(403);
      expect(storageMocks.generatePresignedDownload).not.toHaveBeenCalled();
    });

    it("returns 404 when the message has no attachment or does not exist", async () => {
      const id = await createConversation();
      const sent = await request(app)
        .post(`/api/v1/messaging/conversations/${id}/messages`)
        .set("x-test-user", ALICE)
        .send({ body: "no file" })
        .expect(201);

      await request(app)
        .get(`/api/v1/messaging/messages/${sent.body.data.id}/attachment`)
        .set("x-test-user", ALICE)
        .expect(404);
      await request(app)
        .get(`/api/v1/messaging/messages/${randomUUID()}/attachment`)
        .set("x-test-user", ALICE)
        .expect(404);
    });

    it("returns 404 once the message is deleted", async () => {
      const { messageId } = await sentAttachmentMessage();
      await request(app)
        .delete(`/api/v1/messaging/messages/${messageId}`)
        .set("x-test-user", ALICE)
        .expect(200);
      await request(app)
        .get(`/api/v1/messaging/messages/${messageId}/attachment`)
        .set("x-test-user", BOB)
        .expect(404);
    });
  });

  describe("deleting a message with an attachment", () => {
    it("deletes the attachment object from storage", async () => {
      const id = await createConversation();
      const attachment = await uploadedAttachment(id);
      const sent = await sendAttachmentMessage(id, attachment);

      await request(app)
        .delete(`/api/v1/messaging/messages/${sent.body.data.id}`)
        .set("x-test-user", ALICE)
        .expect(200);
      expect(storageMocks.deleteFile).toHaveBeenCalledWith(attachment.objectKey);
    });

    it("still soft-deletes when storage deletion fails", async () => {
      const id = await createConversation();
      const attachment = await uploadedAttachment(id);
      const sent = await sendAttachmentMessage(id, attachment);
      storageMocks.deleteFile.mockRejectedValue(new Error("S3 down"));

      const res = await request(app)
        .delete(`/api/v1/messaging/messages/${sent.body.data.id}`)
        .set("x-test-user", ALICE)
        .expect(200);
      expect(res.body.data.deletedAt).toBeTruthy();
      expect((await store.findMessageById(sent.body.data.id))?.deletedAt).toBeTruthy();
    });

    it("does not delete the object when a non-sender tries", async () => {
      const id = await createConversation();
      const attachment = await uploadedAttachment(id);
      const sent = await sendAttachmentMessage(id, attachment);

      await request(app)
        .delete(`/api/v1/messaging/messages/${sent.body.data.id}`)
        .set("x-test-user", BOB)
        .expect(403);
      expect(storageMocks.deleteFile).not.toHaveBeenCalled();
    });
  });
});
