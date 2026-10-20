import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockQuery, mockClientQuery, mockRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockClientQuery: vi.fn(),
  mockRelease: vi.fn(),
}));

vi.mock("../db.js", () => ({
  getPool: vi.fn(async () => ({
    query: mockQuery,
    connect: async () => ({ query: mockClientQuery, release: mockRelease }),
  })),
}));

import {
  InMemoryMessagingStore,
  PostgresMessagingStore,
} from "./messagingStore.js";

const CONV = "11111111-1111-4111-8111-111111111111";
const MSG = "22222222-2222-4222-8222-222222222222";
const created = new Date("2026-10-18T10:00:00.000Z");

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MSG,
    conversation_id: CONV,
    sender_id: "alice",
    body: "hi",
    created_at: created,
    edited_at: null,
    deleted_at: null,
    attachment: null,
    ...overrides,
  };
}

describe("InMemoryMessagingStore", () => {
  it("tracks participation, ordering and soft deletes", async () => {
    const store = new InMemoryMessagingStore();
    const conv = await store.createConversation({
      creatorId: "alice",
      participantIds: ["bob", "alice"],
    });
    expect(conv.participants.map((p) => p.userId)).toEqual(["alice", "bob"]);
    expect(await store.isParticipant(conv.id, "bob")).toBe(true);
    expect(await store.isParticipant(conv.id, "mallory")).toBe(false);

    const m = await store.createMessage({
      conversationId: conv.id,
      senderId: "alice",
      body: "x",
      attachment: {
        objectKey: `messaging/${conv.id}/k`,
        fileName: "a.pdf",
        contentType: "application/pdf",
        size: 1,
      },
    });
    expect(await store.isAttachmentKeyInUse(`messaging/${conv.id}/k`)).toBe(true);
    expect((await store.softDeleteMessage(m.id))?.deletedAt).toBeTruthy();
    expect(await store.softDeleteMessage(m.id)).toBeNull();
    expect(await store.listMessages(conv.id)).toHaveLength(0);
    // Deleted messages still hold the key so it cannot be re-attached.
    expect(await store.isAttachmentKeyInUse(`messaging/${conv.id}/k`)).toBe(true);
  });
});

describe("PostgresMessagingStore", () => {
  let store: PostgresMessagingStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new PostgresMessagingStore();
  });

  it("creates a conversation and its participants in one transaction", async () => {
    mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("INSERT INTO conversations")) {
        return {
          rows: [{ id: CONV, subject_type: "deal", subject_id: "d1", created_at: created, updated_at: created }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO conversation_participants")) {
        return {
          rows: [{ user_id: params![1], role: params![2], last_read_at: null, joined_at: created }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const conv = await store.createConversation({
      creatorId: "alice",
      participantIds: ["bob"],
      subjectType: "deal",
      subjectId: "d1",
    });

    const statements = mockClientQuery.mock.calls.map((c) => c[0] as string);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[statements.length - 1]).toBe("COMMIT");
    expect(conv).toMatchObject({
      id: CONV,
      subjectType: "deal",
      subjectId: "d1",
      participants: [
        { userId: "alice", role: "admin" },
        { userId: "bob", role: "member" },
      ],
    });
    expect(mockRelease).toHaveBeenCalled();
  });

  it("rolls back when a participant insert fails", async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("INSERT INTO conversations")) {
        return { rows: [{ id: CONV, created_at: created, updated_at: created }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO conversation_participants")) throw new Error("boom");
      return { rows: [], rowCount: 0 };
    });

    await expect(
      store.createConversation({ creatorId: "alice", participantIds: ["bob"] }),
    ).rejects.toThrow("boom");
    expect(mockClientQuery.mock.calls.map((c) => c[0])).toContain("ROLLBACK");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("stores the attachment as JSONB and maps it back", async () => {
    const attachment = {
      objectKey: `messaging/${CONV}/k-a.pdf`,
      fileName: "a.pdf",
      contentType: "application/pdf",
      size: 10,
    };
    mockQuery.mockResolvedValue({ rows: [messageRow({ attachment })], rowCount: 1 });

    const message = await store.createMessage({
      conversationId: CONV,
      senderId: "alice",
      body: "hi",
      attachment,
    });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("$4::jsonb");
    expect(params[3]).toBe(JSON.stringify(attachment));
    expect(message).toEqual({
      id: MSG,
      conversationId: CONV,
      senderId: "alice",
      body: "hi",
      createdAt: created.toISOString(),
      editedAt: undefined,
      deletedAt: undefined,
      attachment,
    });
  });

  it("excludes deleted messages and applies the before cursor", async () => {
    mockQuery.mockResolvedValue({ rows: [messageRow()], rowCount: 1 });
    await store.listMessages(CONV, { limit: 5, before: created.toISOString() });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("deleted_at IS NULL");
    expect(sql).toContain("created_at < $3");
    expect(params).toEqual([CONV, 5, created.toISOString()]);
  });

  it("soft-deletes only live messages", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [messageRow({ deleted_at: created })],
      rowCount: 1,
    });
    const deleted = await store.softDeleteMessage(MSG);
    expect(deleted?.deletedAt).toBe(created.toISOString());
    expect(mockQuery.mock.calls[0][0]).toContain("deleted_at IS NULL");

    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await store.softDeleteMessage(MSG)).toBeNull();
  });

  it("checks attachment key reuse via the JSONB objectKey", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });
    expect(await store.isAttachmentKeyInUse("messaging/x/k")).toBe(true);
    expect(mockQuery.mock.calls[0][0]).toContain("attachment->>'objectKey'");
  });
});
