import { z } from "zod";

const reference = z.string().min(1).max(256);
export const mentionAudienceIdentitySchema = z.object({
  agentId: reference,
  sessionKey: z.string().min(1).max(512),
  sessionId: reference,
  storePath: z.string().min(1).max(4096).optional(),
  sourceId: reference,
  senderProfileId: reference,
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export type MentionAudienceIdentity = z.infer<typeof mentionAudienceIdentitySchema>;
