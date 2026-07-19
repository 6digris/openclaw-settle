// Whatsapp plugin module implements channel.setup behavior.
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ResolvedWhatsAppAccount } from "./accounts.js";
import { createWhatsAppPluginBase } from "./shared.js";

async function isWhatsAppAuthConfigured(account: ResolvedWhatsAppAccount): Promise<boolean> {
  return (await readWebAuthState(account.authDir)) === "linked";
}

export const whatsappSetupPlugin: ChannelPlugin<ResolvedWhatsAppAccount> = {
  ...createWhatsAppPluginBase(),
};
