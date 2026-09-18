import type { Model } from "../../llm/types.js";
import type { AuthStorage } from "./auth-storage.js";
import type { ProviderAuthMode } from "./model-registry-schema.js";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "./resolve-config-value.js";

export interface ProviderRequestConfig {
  baseUrls?: readonly string[];
  apiKey?: string;
  auth?: ProviderAuthMode;
  headers?: Record<string, string>;
  authHeader?: boolean;
}

export type ResolvedRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };

export async function resolveModelRequestAuth(params: {
  authStorage: AuthStorage;
  model: Model;
  providerConfig: ProviderRequestConfig | undefined;
  getModelHeaders: () => Record<string, string> | undefined;
}): Promise<ResolvedRequestAuth> {
  const { authStorage, model, providerConfig } = params;
  try {
    const usesAwsSdkAuth = providerConfig?.auth === "aws-sdk";
    const lookupOptions = { includeFallback: false, baseUrl: model.baseUrl };
    const apiKeyFromAuthStorage = usesAwsSdkAuth
      ? undefined
      : await authStorage.getApiKey(model.provider, lookupOptions);
    const apiKey =
      apiKeyFromAuthStorage ??
      (!usesAwsSdkAuth && providerConfig?.apiKey
        ? await resolveConfigValueOrThrow(
            providerConfig.apiKey,
            `API key for provider "${model.provider}"`,
          )
        : undefined);

    const providerHeaders = await resolveHeadersOrThrow(
      providerConfig?.headers,
      `provider "${model.provider}"`,
    );
    const modelHeaders = await resolveHeadersOrThrow(
      params.getModelHeaders(),
      `model "${model.provider}/${model.id}"`,
    );

    // Header commands can outlive credential authority. Recheck its existing owner after them.
    if (
      !usesAwsSdkAuth &&
      (await authStorage.getApiKey(model.provider, lookupOptions)) !== apiKeyFromAuthStorage
    ) {
      return {
        ok: false,
        error: `Authentication changed while resolving request headers for "${model.provider}"`,
      };
    }

    let headers =
      model.headers || providerHeaders || modelHeaders
        ? { ...model.headers, ...providerHeaders, ...modelHeaders }
        : undefined;

    if (providerConfig?.authHeader) {
      if (!apiKey) {
        return { ok: false, error: `No API key found for "${model.provider}"` };
      }
      headers = { ...headers, Authorization: `Bearer ${apiKey}` };
    }

    return {
      ok: true,
      apiKey,
      headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
