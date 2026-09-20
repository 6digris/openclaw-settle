import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { SessionVisibilitySchema } from "./sessions-sharing-values.js";

export const MAX_HUMAN_MENTIONS = 10;
export const MAX_MENTIONABLE_USERS = 100;
export const MENTION_INBOX_MAX_ITEMS = 100;

const MentionReferenceSchema = Type.String({ minLength: 1, maxLength: 256 });
const MentionLabelSchema = Type.String({ minLength: 1, maxLength: 256 });
const MentionSessionKeySchema = Type.String({ minLength: 1, maxLength: 512 });
const MentionAvatarUrlSchema = Type.String({ minLength: 1, maxLength: 2048 });
const MentionTimestampSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** Explicit selections bound to UTF-16 offsets in the submitted message text. */
export const HumanMentionSchema = closedObject({
  profileId: MentionReferenceSchema,
  start: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  end: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});
export const HumanMentionsSchema = Type.Array(HumanMentionSchema, {
  maxItems: MAX_HUMAN_MENTIONS,
});

export const UsersMentionableParamsSchema = Type.Union([
  closedObject({
    sessionKey: MentionSessionKeySchema,
    agentId: Type.Optional(MentionReferenceSchema),
    query: Type.Optional(Type.String({ maxLength: 128 })),
  }),
  closedObject({
    agentId: MentionReferenceSchema,
    visibility: Type.Optional(SessionVisibilitySchema),
    query: Type.Optional(Type.String({ maxLength: 128 })),
  }),
]);

export const MentionableUserSchema = closedObject({
  profileId: MentionReferenceSchema,
  displayName: MentionLabelSchema,
  avatarUrl: Type.Optional(MentionAvatarUrlSchema),
  online: Type.Boolean(),
});
export const UsersMentionableResultSchema = closedObject({
  users: Type.Array(MentionableUserSchema, { maxItems: MAX_MENTIONABLE_USERS }),
  truncated: Type.Boolean(),
});

const MentionInboxItemProperties = {
  id: MentionReferenceSchema,
  senderLabel: MentionLabelSchema,
  senderAvatarUrl: Type.Optional(MentionAvatarUrlSchema),
  sessionKey: MentionSessionKeySchema,
  agentId: MentionReferenceSchema,
  sessionTitle: MentionLabelSchema,
  messageId: MentionReferenceSchema,
  createdAt: MentionTimestampSchema,
  expiresAt: MentionTimestampSchema,
  excerpt: Type.Optional(Type.String({ maxLength: 280 })),
};

export const AgentMentionSenderSchema = closedObject({
  type: Type.Literal("agent"),
  id: MentionReferenceSchema,
});
const { id: mentionIdSchema, ...MentionInboxDetailProperties } = MentionInboxItemProperties;
const MentionInboxItemObjectSchema = closedObject({
  id: mentionIdSchema,
  senderProfileId: Type.Optional(MentionReferenceSchema),
  ...MentionInboxDetailProperties,
  sender: Type.Optional(AgentMentionSenderSchema),
});

// Keep the native generated object model while the union enforces exactly one truthful sender.
// Existing human records retain their wire shape; agents never occupy a profile field.
export const MentionInboxItemSchema = Type.Union(
  [
    closedObject({ ...MentionInboxItemProperties, senderProfileId: MentionReferenceSchema }),
    closedObject({ ...MentionInboxItemProperties, sender: AgentMentionSenderSchema }),
  ],
  {
    type: "object",
    properties: MentionInboxItemObjectSchema.properties,
    required: MentionInboxItemObjectSchema.required,
  },
);

export const MentionsListParamsSchema = closedObject({});
export const MentionsDismissParamsSchema = closedObject({
  ids: Type.Array(MentionReferenceSchema, {
    maxItems: MENTION_INBOX_MAX_ITEMS,
    uniqueItems: true,
  }),
});

// Revisions describe only this recipient's authorized view, never Gateway-wide activity.
const MentionInboxVersionProperties = {
  gatewayInstanceId: MentionReferenceSchema,
  revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
};
export const MentionsListResultSchema = closedObject({
  ...MentionInboxVersionProperties,
  items: Type.Array(MentionInboxItemSchema, { maxItems: MENTION_INBOX_MAX_ITEMS }),
});
export const MentionsChangedEventSchema = closedObject(MentionInboxVersionProperties);

export type HumanMention = Static<typeof HumanMentionSchema>;
export type UsersMentionableParams = Static<typeof UsersMentionableParamsSchema>;
export type MentionableUser = Static<typeof MentionableUserSchema>;
export type UsersMentionableResult = Static<typeof UsersMentionableResultSchema>;
export type MentionInboxItem = Static<typeof MentionInboxItemSchema>;
export type MentionsListParams = Static<typeof MentionsListParamsSchema>;
export type MentionsDismissParams = Static<typeof MentionsDismissParamsSchema>;
export type MentionsListResult = Static<typeof MentionsListResultSchema>;
export type MentionsChangedEvent = Static<typeof MentionsChangedEventSchema>;

export const SessionsMentionableParamsSchema = closedObject({
  sessionKey: MentionSessionKeySchema,
  agentId: MentionReferenceSchema,
  query: Type.Optional(Type.String({ maxLength: 128 })),
});
export const SessionsMentionParamsSchema = closedObject({
  sessionKey: MentionSessionKeySchema,
  agentId: MentionReferenceSchema,
  recipientProfileIds: Type.Array(MentionReferenceSchema, {
    minItems: 1,
    maxItems: MAX_HUMAN_MENTIONS,
    uniqueItems: true,
  }),
  message: Type.String({ minLength: 1, maxLength: 4096 }),
  idempotencyKey: MentionReferenceSchema,
});
const MentionRecordResultSchema = Type.Union([
  closedObject({
    status: Type.Literal("recorded"),
    recipientProfileIds: Type.Array(MentionReferenceSchema, {
      minItems: 1,
      maxItems: MAX_HUMAN_MENTIONS,
    }),
  }),
  closedObject({
    status: Type.Literal("skipped"),
    reason: Type.Union([
      Type.Literal("unavailable"),
      Type.Literal("invalid"),
      Type.Literal("session_changed"),
      Type.Literal("already_processed"),
      Type.Literal("capacity"),
      Type.Literal("no_eligible_recipients"),
      Type.Literal("expired"),
    ]),
  }),
]);
export type MentionRecordResult = Static<typeof MentionRecordResultSchema>;
const MentionSourceProperties = {
  sessionKey: MentionSessionKeySchema,
  agentId: MentionReferenceSchema,
  messageId: MentionReferenceSchema,
  messageUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
};
export const SessionsMentionResultSchema = Type.Union([
  closedObject({ ...MentionRecordResultSchema.anyOf[0].properties, ...MentionSourceProperties }),
  closedObject({ ...MentionRecordResultSchema.anyOf[1].properties, ...MentionSourceProperties }),
]);
export type SessionsMentionResult = Static<typeof SessionsMentionResultSchema>;

export type SessionsMentionableParams = Static<typeof SessionsMentionableParamsSchema>;
export type SessionsMentionParams = Static<typeof SessionsMentionParamsSchema>;
