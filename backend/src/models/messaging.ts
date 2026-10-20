/**
 * Messaging domain types.
 *
 * Mirrors the conversations / conversation_participants / messages tables in
 * migrations/041_messaging.sql. This is the minimal subset of the messaging
 * service (#1896) needed to support message attachments (#1898): conversation
 * create/list, message send/list and sender soft-delete. Read state
 * (last_read_at), editing and participant management are not implemented yet.
 */

export type ParticipantRole = "member" | "admin";

export interface ConversationParticipant {
  userId: string;
  role: ParticipantRole;
  lastReadAt?: string;
  joinedAt: string;
}

export interface Conversation {
  id: string;
  subjectType?: string;
  subjectId?: string;
  participants: ConversationParticipant[];
  createdAt: string;
  updatedAt: string;
}

/** Stored in messages.attachment (JSONB). */
export interface MessageAttachment {
  objectKey: string;
  fileName: string;
  contentType: string;
  size: number;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  attachment?: MessageAttachment;
}

export interface CreateConversationData {
  creatorId: string;
  participantIds: string[];
  subjectType?: string;
  subjectId?: string;
}

export interface CreateMessageData {
  conversationId: string;
  senderId: string;
  body: string;
  attachment?: MessageAttachment;
}
