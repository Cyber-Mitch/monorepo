/**
 * Messaging Routes
 *
 * Minimal subset of the messaging service (#1896): create/list the caller's
 * conversations, list/send messages in a conversation and soft-delete one's
 * own messages. Read state, editing and participant management are out of
 * scope here and left for the full #1896 implementation.
 *
 * On top of that, message attachments (#1898):
 *   - POST /conversations/:id/attachments/presign issues a presigned PUT URL
 *     for an object under messaging/<conversationId>/ (images + PDF, <= 10 MB).
 *   - POST /conversations/:id/messages accepts an optional attachment whose
 *     key must sit under that conversation's prefix and whose uploaded object
 *     must exist with an allowed type/size.
 *   - GET /messages/:id/attachment returns a presigned download URL that
 *     expires in at most 5 minutes.
 *   - DELETE /messages/:id soft-deletes the message and removes the attachment
 *     object immediately on a best-effort basis (failures are logged, never
 *     surfaced) — the same approach TenantDocumentService.deleteDocument uses
 *     for storage cleanup; there is no storage-cleanup job queue to defer to.
 *
 * Every route requires authentication and conversation participation.
 */

import { Router, Request, Response, NextFunction } from "express";
import { authenticateToken, type AuthenticatedRequest } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { messagingStore } from "../models/messagingStore.js";
import { Conversation, Message, MessageAttachment } from "../models/messaging.js";
import {
  createConversationSchema,
  conversationIdParamsSchema,
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  messageIdParamsSchema,
  presignAttachmentSchema,
  sendMessageSchema,
  CreateConversationRequest,
  ListMessagesQuery,
  PresignAttachmentRequest,
  SendMessageRequest,
  MESSAGE_ATTACHMENT_MAX_BYTES,
} from "../schemas/messaging.js";
import {
  buildMessageAttachmentObjectKey,
  deleteFile,
  generatePresignedDownload,
  generatePresignedUpload,
  headFile,
  messageAttachmentPrefix,
} from "../services/storageService.js";
import { AppError } from "../errors/AppError.js";
import { ErrorCode } from "../errors/errorCodes.js";
import { auditLog, extractAuditContext } from "../utils/auditLogger.js";
import { logger } from "../utils/logger.js";

/** Presigned upload URLs for attachments are valid for 10 minutes. */
export const MESSAGE_ATTACHMENT_UPLOAD_TTL_SECONDS = 10 * 60;
/** Presigned download URLs for attachments are valid for 5 minutes (max). */
export const MESSAGE_ATTACHMENT_DOWNLOAD_TTL_SECONDS = 5 * 60;

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function requireUserId(req: Request): string {
  const userId = (req as AuthenticatedRequest).user?.id;
  if (!userId) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, "User not authenticated");
  }
  return userId;
}

/** 404 when the conversation does not exist, 403 when the caller is not in it. */
async function requireConversationParticipant(
  conversationId: string,
  userId: string,
): Promise<Conversation> {
  const conversation = await messagingStore.findConversationById(conversationId);
  if (!conversation) {
    throw new AppError(ErrorCode.NOT_FOUND, 404, "Conversation not found");
  }
  if (!conversation.participants.some((p) => p.userId === userId)) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      403,
      "You are not a participant in this conversation",
    );
  }
  return conversation;
}

/** 404 when the message is missing or soft-deleted, 403 for non-participants. */
async function requireVisibleMessage(
  messageId: string,
  userId: string,
): Promise<Message> {
  const message = await messagingStore.findMessageById(messageId);
  if (!message || message.deletedAt) {
    throw new AppError(ErrorCode.NOT_FOUND, 404, "Message not found");
  }
  if (!(await messagingStore.isParticipant(message.conversationId, userId))) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      403,
      "You are not a participant in this conversation",
    );
  }
  return message;
}

/**
 * True when objectKey was issued by the presign route for this conversation:
 * messaging/<conversationId>/<uuid>-<safeName>, with no further path segments.
 */
export function isAttachmentKeyForConversation(
  objectKey: string,
  conversationId: string,
): boolean {
  const prefix = messageAttachmentPrefix(conversationId);
  if (!objectKey.startsWith(prefix)) return false;
  const rest = objectKey.slice(prefix.length);
  return new RegExp(`^${UUID_PATTERN}-[A-Za-z0-9_-][A-Za-z0-9._-]*$`, "i").test(
    rest,
  );
}

function normalizeContentType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

/**
 * Re-validates a client-declared attachment against the conversation prefix
 * and the object actually stored (existence, size, content type).
 */
async function verifyAttachment(
  conversationId: string,
  attachment: MessageAttachment,
): Promise<void> {
  if (!isAttachmentKeyForConversation(attachment.objectKey, conversationId)) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      400,
      "Attachment objectKey does not belong to this conversation",
    );
  }

  if (await messagingStore.isAttachmentKeyInUse(attachment.objectKey)) {
    throw new AppError(
      ErrorCode.CONFLICT,
      409,
      "Attachment has already been sent in another message",
    );
  }

  const stored = await headFile(attachment.objectKey);
  if (!stored) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      400,
      "Attachment has not been uploaded",
    );
  }
  if (stored.size > MESSAGE_ATTACHMENT_MAX_BYTES) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      400,
      "Uploaded attachment exceeds the 10 MB limit",
    );
  }
  if (stored.size !== attachment.size) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      400,
      "Uploaded attachment size does not match the declared size",
    );
  }
  if (
    stored.contentType &&
    normalizeContentType(stored.contentType) !==
      normalizeContentType(attachment.contentType)
  ) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      400,
      "Uploaded attachment content type does not match the declared type",
    );
  }
}

export function createMessagingRouter(): Router {
  const router = Router();

  /**
   * POST /api/v1/messaging/conversations
   * Create a conversation; the caller is always added (role "admin").
   *
   * @authenticated
   */
  router.post(
    "/conversations",
    authenticateToken,
    validate(createConversationSchema, "body"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = requireUserId(req);
        const body = req.body as CreateConversationRequest;
        const others = body.participantIds.filter((id) => id !== userId);
        if (others.length === 0) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            400,
            "participantIds must include at least one other user",
          );
        }
        const conversation = await messagingStore.createConversation({
          creatorId: userId,
          participantIds: others,
          subjectType: body.subjectType,
          subjectId: body.subjectId,
        });
        res.status(201).json({ success: true, data: conversation });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * GET /api/v1/messaging/conversations
   * List conversations the caller participates in, most recently active first.
   *
   * @authenticated
   */
  router.get(
    "/conversations",
    authenticateToken,
    validate(listConversationsQuerySchema, "query"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = requireUserId(req);
        const { limit } = req.query as { limit?: number };
        const conversations = await messagingStore.listConversationsForUser(
          userId,
          { limit },
        );
        res.json({ success: true, data: conversations });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * GET /api/v1/messaging/conversations/:id/messages
   * List non-deleted messages, newest first. Participants only.
   *
   * @authenticated
   */
  router.get(
    "/conversations/:id/messages",
    authenticateToken,
    validate(conversationIdParamsSchema, "params"),
    validate(listMessagesQuerySchema, "query"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = requireUserId(req);
        const conversationId = req.params.id;
        await requireConversationParticipant(conversationId, userId);
        const query = req.query as ListMessagesQuery;
        const messages = await messagingStore.listMessages(conversationId, {
          limit: query.limit,
          before: query.before,
        });
        res.json({ success: true, data: messages });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * POST /api/v1/messaging/conversations/:id/messages
   * Send a message, optionally with a previously uploaded attachment.
   * Participants only.
   *
   * @authenticated
   */
  router.post(
    "/conversations/:id/messages",
    authenticateToken,
    validate(conversationIdParamsSchema, "params"),
    validate(sendMessageSchema, "body"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = requireUserId(req);
        const conversationId = req.params.id;
        await requireConversationParticipant(conversationId, userId);
        const body = req.body as SendMessageRequest;

        if (body.attachment) {
          await verifyAttachment(conversationId, body.attachment);
        }

        const message = await messagingStore.createMessage({
          conversationId,
          senderId: userId,
          body: body.body,
          attachment: body.attachment
            ? {
                objectKey: body.attachment.objectKey,
                fileName: body.attachment.fileName,
                contentType: body.attachment.contentType,
                size: body.attachment.size,
              }
            : undefined,
        });
        res.status(201).json({ success: true, data: message });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * POST /api/v1/messaging/conversations/:id/attachments/presign
   * Issue a presigned upload URL for a message attachment. Participants only.
   *
   * @authenticated
   */
  router.post(
    "/conversations/:id/attachments/presign",
    authenticateToken,
    validate(conversationIdParamsSchema, "params"),
    validate(presignAttachmentSchema, "body"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = requireUserId(req);
        const conversationId = req.params.id;
        await requireConversationParticipant(conversationId, userId);
        const body = req.body as PresignAttachmentRequest;

        const objectKey = buildMessageAttachmentObjectKey(
          conversationId,
          body.fileName,
        );
        const { uploadUrl, expiresAt } = await generatePresignedUpload(
          objectKey,
          body.contentType,
          MESSAGE_ATTACHMENT_UPLOAD_TTL_SECONDS,
        );

        auditLog(
          "MESSAGE_ATTACHMENT_UPLOAD_URL_ISSUED",
          extractAuditContext(req, "user"),
          {
            conversationId,
            objectKey,
            contentType: body.contentType,
            size: body.size,
          },
        );

        res.status(201).json({
          success: true,
          data: { uploadUrl, objectKey, expiresAt },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * GET /api/v1/messaging/messages/:id/attachment
   * Short-lived (<= 5 min) presigned download URL. Participants only.
   *
   * @authenticated
   */
  router.get(
    "/messages/:id/attachment",
    authenticateToken,
    validate(messageIdParamsSchema, "params"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = requireUserId(req);
        const message = await requireVisibleMessage(req.params.id, userId);
        if (!message.attachment) {
          throw new AppError(
            ErrorCode.NOT_FOUND,
            404,
            "Message has no attachment",
          );
        }

        const { downloadUrl, expiresAt } = await generatePresignedDownload(
          message.attachment.objectKey,
          MESSAGE_ATTACHMENT_DOWNLOAD_TTL_SECONDS,
        );

        auditLog(
          "MESSAGE_ATTACHMENT_DOWNLOAD_URL_ISSUED",
          extractAuditContext(req, "user"),
          {
            conversationId: message.conversationId,
            messageId: message.id,
          },
        );

        res.json({
          success: true,
          data: {
            downloadUrl,
            expiresAt,
            fileName: message.attachment.fileName,
            contentType: message.attachment.contentType,
            size: message.attachment.size,
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * DELETE /api/v1/messaging/messages/:id
   * Soft-delete one of the caller's own messages. Any attachment object is
   * deleted from storage immediately on a best-effort basis.
   *
   * @authenticated
   */
  router.delete(
    "/messages/:id",
    authenticateToken,
    validate(messageIdParamsSchema, "params"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = requireUserId(req);
        const message = await requireVisibleMessage(req.params.id, userId);
        if (message.senderId !== userId) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            403,
            "Only the sender can delete this message",
          );
        }

        const deleted = await messagingStore.softDeleteMessage(message.id);
        if (!deleted) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, "Message not found");
        }

        if (deleted.attachment) {
          try {
            await deleteFile(deleted.attachment.objectKey);
          } catch (error) {
            // Never fail the delete on storage errors; log for follow-up cleanup.
            logger.error(
              "Failed to delete message attachment from storage",
              { messageId: deleted.id, objectKey: deleted.attachment.objectKey },
              error,
            );
          }
        }

        auditLog("MESSAGE_DELETED", extractAuditContext(req, "user"), {
          conversationId: deleted.conversationId,
          messageId: deleted.id,
          hadAttachment: !!deleted.attachment,
        });

        res.json({ success: true, data: deleted });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
