// Telegram plugin module implements bot behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { prepareSkillCommandsForAgents } from "openclaw/plugin-sdk/skill-commands-runtime";
import { resolveTelegramAccount } from "./accounts.js";
import { createTelegramBotCore } from "./bot-core.js";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { resolveTelegramNativeCommandSettings } from "./command-config.js";

export function createTelegramBot(
  opts: TelegramBotOptions,
): ReturnType<typeof createTelegramBotCore> {
  return createTelegramBotCore({
    ...opts,
    telegramDeps: opts.telegramDeps ?? defaultTelegramBotDeps,
  });
}

/** Prepare before transport admission; a failed remote read must not become an empty menu. */
export async function prepareTelegramNativeSkillCommands(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  signal?: AbortSignal;
}) {
  params.signal?.throwIfAborted();
  const account = resolveTelegramAccount(params);
  const { nativeEnabled, nativeSkillsEnabled } = resolveTelegramNativeCommandSettings(
    params.cfg,
    account.config,
  );
  if (!nativeEnabled || !nativeSkillsEnabled) {
    return [];
  }
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "telegram",
    accountId: account.accountId,
  });
  return route
    ? await prepareSkillCommandsForAgents({
        cfg: params.cfg,
        agentIds: [route.agentId],
        signal: params.signal,
      })
    : [];
}
