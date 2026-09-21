import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import type { UiSettings } from "../../app/settings.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import type { SessionPatchResult } from "../../lib/sessions/patch.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../../test-helpers/chat-model.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";

export type ChatHeaderTestState = {
  basePath?: string;
  chatLoading: boolean;
  chatMessage: string;
  chatMessages: unknown[];
  chatModelCatalog: ModelCatalogEntry[];
  chatModelsLoading?: boolean;
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatThinkingLevel: string | null;
  chatVerboseLevel: string | null;
  chatAvatarUrl: string | null;
  client: GatewayBrowserClient;
  connected: boolean;
  hello: GatewayHelloOk;
  lastError: string | null;
  modelAuthStatusResult?: ModelAuthStatusResult | null;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  agentsList: null;
  agentsPanel: string;
  agentsSelectedId: string | null;
  settings: UiSettings;
  sessions: SessionCapability;
  setRoute: ReturnType<typeof vi.fn>;
  toolsEffectiveLoading: boolean;
  toolsEffectiveLoadingKey: string | null;
  toolsEffectiveError: string | null;
  toolsEffectiveResultKey: string | null;
  toolsEffectiveResult: unknown;
  applySettings(patch: Partial<UiSettings>): void;
  loadAssistantIdentity(): void;
  resetChatInputHistoryNavigation(): void;
  resetChatScroll(): void;
  resetToolStream(): void;
};

export function createOpenAiModelCatalog(): ModelCatalogEntry[] {
  return [
    { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
    { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
  ];
}

export function createChatHeaderState(
  overrides: {
    model?: string | null;
    modelProvider?: string | null;
    modelOverrideSource?: GatewaySessionRow["modelOverrideSource"];
    models?: ModelCatalogEntry[];
    defaultsThinkingDefault?: string;
    thinkingDefault?: string;
    thinkingLevels?: GatewaySessionRow["thinkingLevels"];
    omitSessionFromList?: boolean;
  } = {},
): { state: ChatHeaderTestState; request: ReturnType<typeof vi.fn> } {
  let currentModel = overrides.model ?? null;
  let currentModelProvider = overrides.modelProvider ?? (currentModel ? "openai" : null);
  const omitSessionFromList = overrides.omitSessionFromList ?? false;
  const catalog = overrides.models ?? createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG);
  let currentEntry:
    | Pick<SessionPatchResult["entry"], "sessionId" | "updatedAt" | "thinkingLevel" | "fastMode">
    | undefined;
  const readSessionsList = () => {
    const result = createSessionsListResult({
      model: currentModel,
      modelProvider: currentModelProvider,
      modelOverrideSource: overrides.modelOverrideSource,
      defaultsThinkingDefault: overrides.defaultsThinkingDefault,
      thinkingDefault: overrides.thinkingDefault,
      thinkingLevels: overrides.thinkingLevels,
      omitSessionFromList,
    });
    const entry = currentEntry;
    if (entry) {
      result.sessions = result.sessions.map((row) => ({
        ...row,
        ...entry,
        ...(typeof entry.fastMode === "boolean" ? { effectiveFastMode: entry.fastMode } : {}),
      }));
    }
    return result;
  };
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "sessions.patch") {
      if (params.model === null || typeof params.model === "string") {
        const nextModel = params.model?.trim();
        if (!nextModel) {
          currentModel = null;
          currentModelProvider = null;
        } else {
          const slashIndex = nextModel.indexOf("/");
          if (slashIndex > 0) {
            currentModelProvider = nextModel.slice(0, slashIndex);
            currentModel = nextModel.slice(slashIndex + 1);
          } else {
            currentModel = nextModel;
            const matchingProviders: string[] = [];
            for (const entry of catalog) {
              if (entry.id === nextModel && entry.provider) {
                matchingProviders.push(entry.provider);
              }
            }
            currentModelProvider =
              matchingProviders.length === 1
                ? expectDefined(matchingProviders[0], "single matching model provider")
                : currentModelProvider;
          }
        }
      }
      const entry = (currentEntry ??= { sessionId: "header-session" });
      entry.updatedAt = (entry.updatedAt ?? 0) + 1;
      if (params.thinkingLevel === null || typeof params.thinkingLevel === "string") {
        entry.thinkingLevel = params.thinkingLevel ?? undefined;
      }
      if (
        params.fastMode === null ||
        typeof params.fastMode === "boolean" ||
        params.fastMode === "auto"
      ) {
        entry.fastMode = params.fastMode ?? undefined;
      }
      return { ok: true, key: "main", path: "", entry: { ...entry } } satisfies SessionPatchResult;
    }
    if (method === "chat.history") {
      return {
        messages: [],
        sessionId: currentEntry?.sessionId,
        thinkingLevel: currentEntry?.thinkingLevel ?? null,
      };
    }
    if (method === "sessions.list") {
      return readSessionsList();
    }
    if (method === "models.list") {
      return { models: catalog };
    }
    if (method === "tools.effective") {
      return {
        agentId: "main",
        profile: "coding",
        groups: [],
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const hello = {
    ...sessionMutationGatewayHello(),
    snapshot: {
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "agent:main:main",
      },
    },
  };
  const sessions = createTestSessionCapability({
    snapshot: { client, phase: "connected", hello },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
  const initialSessionsResult = readSessionsList();
  const state: ChatHeaderTestState = {
    sessionKey: "main",
    connected: true,
    sessionsResult: initialSessionsResult,
    chatModelCatalog: catalog,
    chatModelsLoading: false,
    client,
    settings: {
      gatewayUrl: "",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      navCollapsed: false,
      navWidth: 280,
      sidebarEntries: [],
      chatShowThinking: false,
      chatShowToolCalls: true,
    },
    chatMessage: "",
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunId: null,
    chatQueue: [],
    chatMessages: [],
    chatLoading: false,
    chatSending: false,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    lastError: null,
    chatAvatarUrl: null,
    basePath: "",
    hello,
    agentsList: null,
    agentsPanel: "overview",
    agentsSelectedId: null,
    sessions,
    toolsEffectiveLoading: false,
    toolsEffectiveLoadingKey: null,
    toolsEffectiveResultKey: null,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
    applySettings(patch: Partial<UiSettings>) {
      state.settings = { ...state.settings, ...patch };
    },
    setRoute: vi.fn(),
    loadAssistantIdentity: vi.fn(),
    resetChatInputHistoryNavigation: vi.fn(),
    resetToolStream: vi.fn(),
    resetChatScroll: vi.fn(),
  };
  sessions.subscribe((next) => {
    state.sessionsResult = next.result;
  });
  return { state, request };
}

export function createOpenAiHeaderState(
  overrides: Parameters<typeof createChatHeaderState>[0] = {},
) {
  return createChatHeaderState({
    model: "gpt-5.5",
    modelProvider: "openai",
    models: createOpenAiModelCatalog(),
    ...overrides,
  });
}
