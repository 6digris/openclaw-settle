import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { resolveWhatsAppGroupConversationId } from "./group-conversation.js";

type WhatsAppInboundIngressDecision = Pick<
  ResolvedChannelMessageIngress["ingress"],
  "admission" | "decision" | "decisiveGateId" | "reasonCode"
>;

type WhatsAppInboundTurnAdmission = ReturnType<typeof mapChannelIngressDecisionToTurnAdmission>;

type WhatsAppInboundAdmissionPolicy = {
  account: {
    accountId: string;
    name?: string;
    enabled: boolean;
    sendReadReceipts: boolean;
    selfChatMode?: boolean;
    replyToMode?: ReplyToMode;
  };
  isSelfChat: boolean;
  isSamePhone: (value?: string | null) => boolean;
};

type WhatsAppInboundAdmissionCarrier = {
  admission?: WhatsAppInboundAdmission;
};

/**
 * Public-safe accepted inbound facts resolved by access control.
 *
 * Keep this as an admission envelope around the canonical turn admission and
 * redacted ingress decision. Never publish the resolved ingress graph because
 * its sender-access projection contains effective allowlists.
 */
export type WhatsAppInboundAdmission = {
  channelIngress?: ResolvedChannelMessageIngress;
  accountId: string;
  isSelfChat: boolean;
  account: {
    accountId: string;
    name?: string;
    enabled: boolean;
    sendReadReceipts: boolean;
    selfChatMode?: boolean;
    replyToMode?: ReplyToMode;
  };
  conversation: {
    kind: "direct" | "group";
    id: string;
    groupSessionId: string;
  };
  sender: {
    id: string;
    isSamePhone: boolean;
  };
  ingress: WhatsAppInboundIngressDecision;
  turnAdmission: WhatsAppInboundTurnAdmission;
};

type WhatsAppIngressResolver = (
  contextBinding: ChannelIngressContextBinding,
) => Promise<ResolvedChannelMessageIngress>;
const ingressResolverByAdmission = new WeakMap<WhatsAppInboundAdmission, WhatsAppIngressResolver>();

function copyAccount(
  account: WhatsAppInboundAdmissionPolicy["account"],
): WhatsAppInboundAdmission["account"] {
  const copied: WhatsAppInboundAdmission["account"] = {
    accountId: account.accountId,
    enabled: account.enabled,
    sendReadReceipts: account.sendReadReceipts,
  };
  if (account.name) {
    copied.name = account.name;
  }
  if (typeof account.selfChatMode === "boolean") {
    copied.selfChatMode = account.selfChatMode;
  }
  if (account.replyToMode) {
    copied.replyToMode = account.replyToMode;
  }
  return copied;
}

export function buildWhatsAppInboundAdmission(params: {
  policy: WhatsAppInboundAdmissionPolicy;
  access: WhatsAppInboundAdmissionAccess;
  channelIngress?: ResolvedChannelMessageIngress;
  resolveChannelIngress?: WhatsAppIngressResolver;
  isGroup: boolean;
  conversationId: string;
  senderId: string;
}): WhatsAppInboundAdmission {
  const admission: WhatsAppInboundAdmission = {
    channelIngress: params.channelIngress,
    accountId: params.policy.account.accountId,
    isSelfChat: params.policy.isSelfChat,
    account: copyAccount(params.policy.account),
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.conversationId,
      groupSessionId: resolveWhatsAppGroupConversationId(params.conversationId),
    },
    sender: {
      id: params.senderId,
      isSamePhone: params.policy.isSamePhone(params.senderId),
    },
    ingress: {
      admission: params.ingress.admission,
      decision: params.ingress.decision,
      decisiveGateId: params.ingress.decisiveGateId,
      reasonCode: params.ingress.reasonCode,
    },
    turnAdmission: params.turnAdmission,
  };
  if (params.resolveChannelIngress) {
    ingressResolverByAdmission.set(admission, params.resolveChannelIngress);
  }
  return admission;
}

export async function resolveWhatsAppAdmissionChannelIngress(
  admission: WhatsAppInboundAdmission,
  contextBinding: ChannelIngressContextBinding,
): Promise<ResolvedChannelMessageIngress | undefined> {
  return await ingressResolverByAdmission.get(admission)?.(contextBinding);
}

export function requireWhatsAppInboundAdmission(
  params: WhatsAppInboundAdmissionCarrier,
): WhatsAppInboundAdmission {
  if (!params.admission) {
    throw new Error("WhatsApp inbound message is missing admission facts");
  }
  return params.admission;
}
