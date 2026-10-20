import { z } from "zod";

/**
 * Message attachment policy (#1898): images + PDF only, at most 10 MB.
 * SVG is deliberately excluded (it can carry script).
 */
export const MESSAGE_ATTACHMENT_ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;

export const MESSAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const MESSAGE_BODY_MAX_LENGTH = 4000;

export const attachmentContentTypeSchema = z.enum(
  MESSAGE_ATTACHMENT_ALLOWED_CONTENT_TYPES,
  {
    errorMap: () => ({
      message: `contentType must be one of: ${MESSAGE_ATTACHMENT_ALLOWED_CONTENT_TYPES.join(", ")}`,
    }),
  },
);

const attachmentSizeSchema = z
  .number()
  .int()
  .positive()
  .max(MESSAGE_ATTACHMENT_MAX_BYTES, {
    message: `size must be at most ${MESSAGE_ATTACHMENT_MAX_BYTES} bytes (10 MB)`,
  });

const fileNameSchema = z.string().trim().min(1).max(255);

export const conversationIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const messageIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const createConversationSchema = z.object({
  participantIds: z.array(z.string().trim().min(1).max(128)).min(1).max(50),
  subjectType: z.string().trim().min(1).max(64).optional(),
  subjectId: z.string().trim().min(1).max(128).optional(),
});

export const listConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().datetime().optional(),
});

export const presignAttachmentSchema = z.object({
  fileName: fileNameSchema,
  contentType: attachmentContentTypeSchema,
  size: attachmentSizeSchema,
});

export const messageAttachmentSchema = z.object({
  objectKey: z.string().min(1).max(512),
  fileName: fileNameSchema,
  contentType: attachmentContentTypeSchema,
  size: attachmentSizeSchema,
});

export const sendMessageSchema = z
  .object({
    body: z.string().max(MESSAGE_BODY_MAX_LENGTH).optional().default(""),
    attachment: messageAttachmentSchema.optional(),
  })
  .refine((data) => data.body.trim().length > 0 || !!data.attachment, {
    message: "A message needs a non-empty body or an attachment",
    path: ["body"],
  });

export type CreateConversationRequest = z.infer<typeof createConversationSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
export type PresignAttachmentRequest = z.infer<typeof presignAttachmentSchema>;
export type SendMessageRequest = z.infer<typeof sendMessageSchema>;
