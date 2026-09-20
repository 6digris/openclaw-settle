import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";

const FEISHU_NATIVE_CHAT_TARGET_ALIASES = ["chatId", "chat_id", "channel_id"];

function createMessageMutationTargetAliases() {
  // The shared cross-context guard only sees plugin-native destinations declared here.
  // Keep every guarded mutation that consumes resolveFeishuChatId on this contract.
  return {
    aliases: ["messageId", ...FEISHU_NATIVE_CHAT_TARGET_ALIASES],
    deliveryTargetAliases: [...FEISHU_NATIVE_CHAT_TARGET_ALIASES],
  };
}

export const messageActionTargetAliases = {
  read: { aliases: ["messageId"] },
  edit: createMessageMutationTargetAliases(),
  pin: createMessageMutationTargetAliases(),
  unpin: createMessageMutationTargetAliases(),
  "list-pins": { aliases: ["chatId"] },
  "channel-info": { aliases: ["chatId"] },
} satisfies NonNullable<ChannelMessageActionAdapter["messageActionTargetAliases"]>;

export function readFirstString(
  params: Record<string, unknown>,
  keys: string[],
  fallback?: string | null,
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return undefined;
}
