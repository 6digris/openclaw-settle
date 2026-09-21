import type { Result } from "@openclaw/normalization-core/result";
import type {
  ErrorShape,
  MentionsListResult,
  UsersMentionableParams,
  UsersMentionableResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { MentionAudienceIdentity } from "./mention-inbox-audience-schema.js";
import type { GatewayClient } from "./server-methods/client-types.js";

export type MentionCommittedInput = {
  sourceId: string;
  committedSource: { generation: string; sequence: number; timestamp: number };
  sessionKey: string;
  agentId?: string;
  sessionId: string;
  messageId: string;
  senderProfileId: string;
  recipientProfileIds: readonly string[];
  excerpt?: string;
  /** Exact private source custody; only a retained everyone token permits its fanout. */
  everyoneAudience?: { identity: MentionAudienceIdentity; retained: boolean };
};

/** Keep the Gateway context independent of its context-consuming Inbox implementation. */
export type MentionInbox = {
  mentionable: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
    publish: (result: Result<UsersMentionableResult, ErrorShape>) => undefined,
  ) => Promise<void>;
  validateRecipients: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
    profileIds: readonly string[],
  ) => Result<readonly string[], ErrorShape>;
  /** Prepare the bounded roster, then resolve current access without another yield. */
  prepareEveryoneRecipients: () => Promise<Result<undefined, ErrorShape>>;
  resolveEveryoneRecipients: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
  ) => Result<readonly string[], ErrorShape>;
  retainEveryoneAudience: (
    client: GatewayClient | null,
    identity: MentionAudienceIdentity,
    options: { assertCurrent: () => void } & (
      | { recipients: readonly string[]; recovered: boolean }
      | { recovered: true }
    ),
  ) => void;
  list: (client: GatewayClient | null) => Result<MentionsListResult, ErrorShape>;
  dismiss: (
    client: GatewayClient | null,
    ids: readonly string[],
  ) => Result<MentionsListResult, ErrorShape>;
  recordCommittedInput: (input: MentionCommittedInput) => void;
  invalidate: (sessionKey?: string) => void;
  dispose: () => void;
};
