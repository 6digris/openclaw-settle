import { CHAT_HISTORY_MAX_ENTRIES } from "../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveThinkingDefault } from "../agents/model-selection.js";
import { readPreparedModelCatalog } from "../agents/prepared-model-catalog.js";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEffectiveChatHistoryMaxChars } from "../gateway/chat-display-projection.js";
import {
  normalizeLiveAssistantBufferedText,
  projectLiveAssistantBufferedText,
} from "../gateway/live-chat-projector.js";
import { getMaxChatHistoryMessagesBytes } from "../gateway/server-constants.js";
import {
  createChatHistoryActivityProjection,
  createChatHistoryByteCounter,
} from "../gateway/server-methods/chat-history-budget.js";
import { enrichChatHistoryCompactionMarkers } from "../gateway/server-methods/chat-history-page-kernel.js";
import { readChatHistoryPage } from "../gateway/server-methods/chat-history-pages.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  replaceOversizedChatHistoryMessages,
} from "../gateway/server-methods/chat.js";
import type { SessionRowProjection } from "../gateway/session-row-projection.js";
import { capArrayByJsonBytes } from "../gateway/session-transcript-readers.js";
import { buildGatewaySessionRow } from "../gateway/session-utils-row.js";
import { createGatewaySessionEntryReader } from "../gateway/session-utils-store-lookup.js";
import {
  getSessionDefaults,
  loadGatewaySessionEntryReadOnly,
  resolveSessionModelRef,
} from "../gateway/session-utils.js";
import {
  agentSessionKeysMatchByRequestKey,
  isIncognitoSessionKey,
  normalizeAgentId,
} from "../routing/session-key.js";
import type { LocalRunState } from "./embedded-local-run.js";
import type { TuiBackend } from "./tui-backend.js";
import { formatTuiErrorMessage } from "./tui-formatters.js";

function ensureEmbeddedHistoryRuntimePluginsLoaded(params: {
  cfg: OpenClawConfig;
  sessionAgentId: string;
}): { status: "warmed" } | { status: "failed"; error: string } {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.sessionAgentId);
    loadAgentRuntimePluginRegistryHandle({
      config: params.cfg,
      workspaceDir,
    });
    return { status: "warmed" };
  } catch (err) {
    return { status: "failed", error: formatTuiErrorMessage(err) };
  }
}

/** Projects canonical transcript history without taking ownership of foreground runs. */
export async function loadEmbeddedHistory(
  opts: Parameters<TuiBackend["loadHistory"]>[0],
  context: {
    runs: ReadonlyMap<string, LocalRunState>;
    getSessionProjection: () => Promise<SessionRowProjection> | undefined;
  },
) {
  const loadOptions = opts.agentId ? { agentId: opts.agentId } : undefined;
  const selected = loadGatewaySessionEntryReadOnly(opts.sessionKey, {
    ...loadOptions,
    includeStoreChildEntries: true,
  });
  const {
    cfg,
    agentId: sessionAgentId,
    storePath,
    store,
    readSource,
    entry,
    canonicalKey,
  } = selected;
  const sessionId = entry?.sessionId;
  const runtimePluginsPrewarm = ensureEmbeddedHistoryRuntimePluginsLoaded({
    cfg,
    sessionAgentId,
  });
  const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId);
  const max = Math.min(CHAT_HISTORY_MAX_ENTRIES, typeof opts.limit === "number" ? opts.limit : 200);
  const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
  const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars();
  const historyPage = await readChatHistoryPage({
    entry,
    provider: resolvedSessionModel.provider,
    sessionId,
    storePath,
    sessionAgentId,
    canonicalKey,
    max,
    maxHistoryBytes,
    effectiveMaxChars,
    offset: undefined,
    messageId: undefined,
  });
  const normalized = enrichChatHistoryCompactionMarkers(historyPage.messages, entry);
  const activity = createChatHistoryActivityProjection(normalized, historyPage.activity);
  const byteCounter = createChatHistoryByteCounter(activity);
  const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const replaced = replaceOversizedChatHistoryMessages({
    messages: normalized,
    byteCounter,
    maxSingleMessageBytes: perMessageHardCap,
  });
  const messages = capArrayByJsonBytes(
    replaced.messages,
    maxHistoryBytes - byteCounter.framingBytes(replaced.messages),
    byteCounter.messageBytes,
  ).items;
  const newestInFlightRun = [...context.runs.entries()].findLast(
    ([, run]) =>
      !run.isBtw &&
      run.terminalState !== "final" &&
      agentSessionKeysMatchByRequestKey(run.sessionKey, opts.sessionKey) &&
      normalizeAgentId(run.agentId) === normalizeAgentId(sessionAgentId),
  );
  const inFlightRun = newestInFlightRun
    ? {
        runId: newestInFlightRun[0],
        text: projectLiveAssistantBufferedText(
          normalizeLiveAssistantBufferedText(newestInFlightRun[1].buffer, {
            managedMediaUrls: [...newestInFlightRun[1].managedMediaUrls],
          }).trim(),
          { suppressLeadFragments: true },
        ).text.trim(),
      }
    : undefined;

  let thinkingLevel = entry?.thinkingLevel;
  if (!thinkingLevel) {
    const catalog = await readPreparedModelCatalog({
      config: cfg,
      agentId: sessionAgentId,
      readOnly: true,
    });
    thinkingLevel = resolveThinkingDefault({
      cfg,
      agentId: sessionAgentId,
      provider: resolvedSessionModel.provider,
      model: resolvedSessionModel.model,
      catalog,
    });
  }

  const defaults = getSessionDefaults(cfg, undefined, { allowPluginNormalization: false });
  const projection = await context.getSessionProjection();
  if (projection) {
    do {
      await projection.ensureMaterialized();
    } while (projection.needsMaterialization);
  }
  const target = {
    key: canonicalKey,
    agentId: sessionAgentId,
    storePath: readSource?.path ?? storePath,
  };
  const current = projection?.describe(target);
  const sessionInfo =
    entry && (entry.incognito || isIncognitoSessionKey(canonicalKey))
      ? buildGatewaySessionRow({
          cfg,
          storePath,
          store,
          key: canonicalKey,
          entry,
          agentId: sessionAgentId,
          modelSource: { entry, readSourceEntry: createGatewaySessionEntryReader(selected) },
          lightweightListRow: true,
          skipTranscriptUsageFallback: true,
        })
      : entry &&
          current &&
          current.entry.sessionId === sessionId &&
          current.entry.lifecycleRevision === entry.lifecycleRevision
        ? (projection?.snapshot(target).row ?? undefined)
        : undefined;
  const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
  if (sessionInfo) {
    sessionInfo.thinkingLevel = thinkingLevel;
    sessionInfo.verboseLevel = verboseLevel;
  }

  return {
    sessionKey: opts.sessionKey,
    sessionId,
    messages,
    defaults,
    activity: messages.flatMap((message) => activity.get(message) ?? []),
    ...(sessionInfo ? { sessionInfo } : {}),
    thinkingLevel,
    fastMode: entry?.fastMode,
    verboseLevel,
    runtimePluginsPrewarm,
    ...(inFlightRun ? { inFlightRun } : {}),
  };
}
