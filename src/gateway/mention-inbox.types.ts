import type { Result } from "@openclaw/normalization-core/result";
import type {
  ErrorShape,
  MentionsListResult,
  MentionRecordResult,
  UsersMentionableParams,
  UsersMentionableResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { MentionStoreMessage } from "./mention-inbox-store.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import type { resolveSessionSharingTarget } from "./session-sharing.js";

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
};

export type AgentMentionCommittedInput = Omit<MentionCommittedInput, "senderProfileId"> & {
  sender: { type: "agent"; id: string };
  assertCurrent: () => void;
};
export type { MentionRecordResult } from "../../packages/gateway-protocol/src/index.js";

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
  list: (client: GatewayClient | null) => Result<MentionsListResult, ErrorShape>;
  dismiss: (
    client: GatewayClient | null,
    ids: readonly string[],
  ) => Result<MentionsListResult, ErrorShape>;
  recordCommittedInput: (
    input: MentionCommittedInput | AgentMentionCommittedInput,
  ) => MentionRecordResult;
  agentMentionable: (
    input: { sessionKey: string; agentId: string; query?: string },
    assertCurrent: () => void,
    publish: (result: Result<UsersMentionableResult, ErrorShape>) => void,
  ) => Promise<void>;
  validateAgentRecipients: (
    input: { sessionKey: string; agentId: string },
    profileIds: readonly string[],
  ) => Result<readonly string[], ErrorShape>;
  invalidate: (sessionKey?: string) => void;
  dispose: () => void;
};

export type StoredMention = {
  id: string;
  recipientProfileId: string;
  source: ProcessedSource;
  message: MentionStoreMessage;
};

export type ProcessedSource = {
  key: string;
  sequence: number;
  expiresAt: number;
  /** Null retains consumption after dismissal, eviction, or intentional non-delivery. */
  recipients: Map<string, StoredMention | null>;
};

export type MentionNotification = {
  id: string;
  recipientProfileId: string;
  sessionKey: string;
  agentId: string;
  senderLabel: string;
  messageId: string;
  sessionTitle: string;
  isCurrent: () => boolean;
};

export type SharingTargets = Map<
  string,
  { sessionKey: string; target: ReturnType<typeof resolveSessionSharingTarget> }
>;
