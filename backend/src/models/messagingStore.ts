/**
 * Messaging Store
 * In-memory and PostgreSQL implementations over the 041_messaging tables.
 *
 * Minimal subset of the messaging service (#1896): enough to create/list
 * conversations, send/list messages and soft-delete them, which is what
 * message attachments (#1898) build on.
 */

import { randomUUID } from "node:crypto";
import { getPool } from "../db.js";
import {
  Conversation,
  ConversationParticipant,
  CreateConversationData,
  CreateMessageData,
  Message,
  MessageAttachment,
} from "./messaging.js";

export interface ListMessagesOptions {
  limit?: number;
  /** Only return messages created strictly before this ISO timestamp. */
  before?: string;
}

export interface MessagingStore {
  createConversation(data: CreateConversationData): Promise<Conversation>;
  findConversationById(conversationId: string): Promise<Conversation | null>;
  isParticipant(conversationId: string, userId: string): Promise<boolean>;
  listConversationsForUser(
    userId: string,
    options?: { limit?: number },
  ): Promise<Conversation[]>;
  createMessage(data: CreateMessageData): Promise<Message>;
  /** Newest first; soft-deleted messages are excluded. */
  listMessages(
    conversationId: string,
    options?: ListMessagesOptions,
  ): Promise<Message[]>;
  /** Returns the message even when soft-deleted (deletedAt set). */
  findMessageById(messageId: string): Promise<Message | null>;
  /** Sets deleted_at; returns null when missing or already deleted. */
  softDeleteMessage(messageId: string): Promise<Message | null>;
  /** True when any message (deleted or not) already references this object key. */
  isAttachmentKeyInUse(objectKey: string): Promise<boolean>;
}

const DEFAULT_CONVERSATION_LIMIT = 50;
const DEFAULT_MESSAGE_LIMIT = 50;

function uniqueParticipantIds(data: CreateConversationData): string[] {
  return Array.from(new Set([data.creatorId, ...data.participantIds]));
}

/**
 * In-memory implementation for testing
 */
export class InMemoryMessagingStore implements MessagingStore {
  private conversations: Map<string, Conversation> = new Map();
  private messages: Map<string, Message> = new Map();

  async createConversation(
    data: CreateConversationData,
  ): Promise<Conversation> {
    const now = new Date().toISOString();
    const participants: ConversationParticipant[] = uniqueParticipantIds(
      data,
    ).map((userId) => ({
      userId,
      role: userId === data.creatorId ? "admin" : "member",
      joinedAt: now,
    }));
    const conversation: Conversation = {
      id: randomUUID(),
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      participants,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversation.id, conversation);
    return structuredClone(conversation);
  }

  async findConversationById(
    conversationId: string,
  ): Promise<Conversation | null> {
    const conversation = this.conversations.get(conversationId);
    return conversation ? structuredClone(conversation) : null;
  }

  async isParticipant(conversationId: string, userId: string): Promise<boolean> {
    const conversation = this.conversations.get(conversationId);
    return !!conversation?.participants.some((p) => p.userId === userId);
  }

  async listConversationsForUser(
    userId: string,
    options?: { limit?: number },
  ): Promise<Conversation[]> {
    const limit = options?.limit ?? DEFAULT_CONVERSATION_LIMIT;
    return Array.from(this.conversations.values())
      .filter((c) => c.participants.some((p) => p.userId === userId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((c) => structuredClone(c));
  }

  async createMessage(data: CreateMessageData): Promise<Message> {
    const conversation = this.conversations.get(data.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    const now = new Date().toISOString();
    const message: Message = {
      id: randomUUID(),
      conversationId: data.conversationId,
      senderId: data.senderId,
      body: data.body,
      createdAt: now,
      attachment: data.attachment ? { ...data.attachment } : undefined,
    };
    this.messages.set(message.id, message);
    // Mirrors trigger_update_conversation_on_message
    conversation.updatedAt = now;
    return structuredClone(message);
  }

  async listMessages(
    conversationId: string,
    options?: ListMessagesOptions,
  ): Promise<Message[]> {
    const limit = options?.limit ?? DEFAULT_MESSAGE_LIMIT;
    const before = options?.before;
    return Array.from(this.messages.values())
      .filter(
        (m) =>
          m.conversationId === conversationId &&
          !m.deletedAt &&
          (!before || m.createdAt < before),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((m) => structuredClone(m));
  }

  async findMessageById(messageId: string): Promise<Message | null> {
    const message = this.messages.get(messageId);
    return message ? structuredClone(message) : null;
  }

  async softDeleteMessage(messageId: string): Promise<Message | null> {
    const message = this.messages.get(messageId);
    if (!message || message.deletedAt) return null;
    message.deletedAt = new Date().toISOString();
    return structuredClone(message);
  }

  async isAttachmentKeyInUse(objectKey: string): Promise<boolean> {
    for (const message of this.messages.values()) {
      if (message.attachment?.objectKey === objectKey) return true;
    }
    return false;
  }

  // Test helper
  async clear(): Promise<void> {
    this.conversations.clear();
    this.messages.clear();
  }
}

/**
 * PostgreSQL implementation
 */
export class PostgresMessagingStore implements MessagingStore {
  private async pool() {
    const pool = await getPool();
    if (!pool) throw new Error("Database pool not initialized");
    return pool;
  }

  async createConversation(
    data: CreateConversationData,
  ): Promise<Conversation> {
    const pool = await this.pool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const convResult = await client.query(
        `INSERT INTO conversations (subject_type, subject_id)
         VALUES ($1, $2)
         RETURNING id, subject_type, subject_id, created_at, updated_at`,
        [data.subjectType ?? null, data.subjectId ?? null],
      );
      const conversationRow = convResult.rows[0];
      const participantRows: any[] = [];
      for (const userId of uniqueParticipantIds(data)) {
        const role = userId === data.creatorId ? "admin" : "member";
        const result = await client.query(
          `INSERT INTO conversation_participants (conversation_id, user_id, role)
           VALUES ($1, $2, $3)
           RETURNING user_id, role, last_read_at, joined_at`,
          [conversationRow.id, userId, role],
        );
        participantRows.push(result.rows[0]);
      }
      await client.query("COMMIT");
      return this.mapConversation(conversationRow, participantRows);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async findConversationById(
    conversationId: string,
  ): Promise<Conversation | null> {
    const pool = await this.pool();
    const result = await pool.query(
      `SELECT id, subject_type, subject_id, created_at, updated_at
       FROM conversations WHERE id = $1`,
      [conversationId],
    );
    if (!result.rows[0]) return null;
    const participants = await this.loadParticipants([conversationId]);
    return this.mapConversation(
      result.rows[0],
      participants.get(conversationId) ?? [],
    );
  }

  async isParticipant(conversationId: string, userId: string): Promise<boolean> {
    const pool = await this.pool();
    const result = await pool.query(
      `SELECT 1 FROM conversation_participants
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    return result.rows.length > 0;
  }

  async listConversationsForUser(
    userId: string,
    options?: { limit?: number },
  ): Promise<Conversation[]> {
    const pool = await this.pool();
    const limit = options?.limit ?? DEFAULT_CONVERSATION_LIMIT;
    const result = await pool.query(
      `SELECT c.id, c.subject_type, c.subject_id, c.created_at, c.updated_at
       FROM conversations c
       JOIN conversation_participants p ON p.conversation_id = c.id
       WHERE p.user_id = $1
       ORDER BY c.updated_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    const ids = result.rows.map((row) => row.id as string);
    const participants = await this.loadParticipants(ids);
    return result.rows.map((row) =>
      this.mapConversation(row, participants.get(row.id) ?? []),
    );
  }

  async createMessage(data: CreateMessageData): Promise<Message> {
    const pool = await this.pool();
    const result = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, body, attachment)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING ${MESSAGE_COLUMNS}`,
      [
        data.conversationId,
        data.senderId,
        data.body,
        data.attachment ? JSON.stringify(data.attachment) : null,
      ],
    );
    return this.mapMessage(result.rows[0]);
  }

  async listMessages(
    conversationId: string,
    options?: ListMessagesOptions,
  ): Promise<Message[]> {
    const pool = await this.pool();
    const limit = options?.limit ?? DEFAULT_MESSAGE_LIMIT;
    const params: unknown[] = [conversationId, limit];
    let query = `SELECT ${MESSAGE_COLUMNS}
       FROM messages
       WHERE conversation_id = $1 AND deleted_at IS NULL`;
    if (options?.before) {
      params.push(options.before);
      query += ` AND created_at < $${params.length}`;
    }
    query += ` ORDER BY created_at DESC LIMIT $2`;
    const result = await pool.query(query, params);
    return result.rows.map((row) => this.mapMessage(row));
  }

  async findMessageById(messageId: string): Promise<Message | null> {
    const pool = await this.pool();
    const result = await pool.query(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = $1`,
      [messageId],
    );
    return result.rows[0] ? this.mapMessage(result.rows[0]) : null;
  }

  async softDeleteMessage(messageId: string): Promise<Message | null> {
    const pool = await this.pool();
    const result = await pool.query(
      `UPDATE messages SET deleted_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING ${MESSAGE_COLUMNS}`,
      [messageId],
    );
    return result.rows[0] ? this.mapMessage(result.rows[0]) : null;
  }

  async isAttachmentKeyInUse(objectKey: string): Promise<boolean> {
    const pool = await this.pool();
    const result = await pool.query(
      `SELECT 1 FROM messages WHERE attachment->>'objectKey' = $1 LIMIT 1`,
      [objectKey],
    );
    return result.rows.length > 0;
  }

  private async loadParticipants(
    conversationIds: string[],
  ): Promise<Map<string, any[]>> {
    const map = new Map<string, any[]>();
    if (conversationIds.length === 0) return map;
    const pool = await this.pool();
    const result = await pool.query(
      `SELECT conversation_id, user_id, role, last_read_at, joined_at
       FROM conversation_participants
       WHERE conversation_id = ANY($1::uuid[])
       ORDER BY joined_at ASC`,
      [conversationIds],
    );
    for (const row of result.rows) {
      const list = map.get(row.conversation_id) ?? [];
      list.push(row);
      map.set(row.conversation_id, list);
    }
    return map;
  }

  private mapConversation(row: any, participantRows: any[]): Conversation {
    return {
      id: row.id,
      subjectType: row.subject_type ?? undefined,
      subjectId: row.subject_id ?? undefined,
      participants: participantRows.map((p) => ({
        userId: p.user_id,
        role: p.role,
        lastReadAt: toIso(p.last_read_at),
        joinedAt: toIso(p.joined_at) as string,
      })),
      createdAt: toIso(row.created_at) as string,
      updatedAt: toIso(row.updated_at) as string,
    };
  }

  private mapMessage(row: any): Message {
    const attachment =
      typeof row.attachment === "string"
        ? (JSON.parse(row.attachment) as MessageAttachment)
        : ((row.attachment ?? undefined) as MessageAttachment | undefined);
    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      body: row.body,
      createdAt: toIso(row.created_at) as string,
      editedAt: toIso(row.edited_at),
      deletedAt: toIso(row.deleted_at),
      attachment: attachment ?? undefined,
    };
  }
}

const MESSAGE_COLUMNS =
  "id, conversation_id, sender_id, body, created_at, edited_at, deleted_at, attachment";

function toIso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

// Singleton instance
let messagingStore: MessagingStore = new InMemoryMessagingStore();

export function initMessagingStore(store: MessagingStore): void {
  messagingStore = store;
}

export { messagingStore };
