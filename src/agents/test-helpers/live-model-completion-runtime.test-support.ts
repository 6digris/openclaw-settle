import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import {
  prepareHeadersForSimpleCompletion,
  prepareModelForSimpleCompletion,
} from "@openclaw/ai/transports";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Api, Model } from "../../llm/types.js";

type LiveModelCompletionOptions = {
  getConfig: () => OpenClawConfig | undefined;
  withHeartbeat: <T>(operation: Promise<T>, context: string) => Promise<T>;
};

/** Owns the sweep's adapters independently of built plugins' default registry. */
export function createLiveModelCompletionRuntime(params: LiveModelCompletionOptions) {
  const apiRegistry = createApiRegistry();
  registerBuiltInApiProviders(apiRegistry);
  const { completeSimple } = createLlmRuntime(apiRegistry);

  async function completeWithTimeout<TApi extends Api>(
    model: Model<TApi>,
    context: Parameters<typeof completeSimple<TApi>>[1],
    options: Parameters<typeof completeSimple<TApi>>[2],
    timeoutMs: number,
    progressContext: string,
  ) {
    const maxTimeoutMs = Math.max(1, timeoutMs);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => {
      controller.abort();
    }, maxTimeoutMs);
    abortTimer.unref?.();
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      hardTimer = setTimeout(() => {
        reject(new Error(`model call timed out after ${maxTimeoutMs}ms`));
      }, maxTimeoutMs);
      hardTimer.unref?.();
    });
    try {
      const completion = import("../ai-transport-runtime-host.js").then(
        ({ configureAiTransportRuntimeHost }) => {
          configureAiTransportRuntimeHost();
          controller.signal.throwIfAborted();
          const completionModel = prepareModelForSimpleCompletion({
            apiRegistry,
            model,
            cfg: params.getConfig(),
          });
          const headers = prepareHeadersForSimpleCompletion(completionModel, options);
          return completeSimple(completionModel, context, {
            ...options,
            ...(headers ? { headers } : {}),
            signal: controller.signal,
          });
        },
      );
      return await params.withHeartbeat(Promise.race([completion, timeout]), progressContext);
    } finally {
      clearTimeout(abortTimer);
      if (hardTimer) {
        clearTimeout(hardTimer);
      }
    }
  }

  return { apiRegistry, completeWithTimeout };
}
