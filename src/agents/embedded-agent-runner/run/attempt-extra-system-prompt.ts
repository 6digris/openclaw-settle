import {
  bindExtraSystemPromptContext,
  copyExtraSystemPromptContext,
  readExtraSystemPromptContext,
} from "../../extra-system-prompt-context.js";
import { prepareExtraSystemPrompt } from "../../extra-system-prompt.js";
import { appendIncognitoSystemPrompt } from "../../incognito-system-prompt.js";
import { appendProgressCardSystemPrompt } from "../../progress-card-system-prompt.js";
import type { RunEmbeddedAgentParams } from "./params.js";

/** Keep dispatch-owned requirements separate from the caller's supplemental text. */
export async function prepareRunExtraSystemPrompt(
  params: RunEmbeddedAgentParams,
  options: {
    agentId: string;
    authProfileId?: string;
    provider: string;
    modelId: string;
    contextTokenBudget?: number;
    prepareAtDispatch: boolean;
  },
) {
  const incognitoSystemPrompt = appendIncognitoSystemPrompt({
    agentId: options.agentId,
    extraSystemPrompt: params.extraSystemPrompt,
    sessionKey: params.sessionKey,
    storePath: params.sessionTarget?.storePath,
  });
  const runtimeExtraSystemPrompt = await appendProgressCardSystemPrompt({
    agentId: options.agentId,
    authProfileId: options.authProfileId,
    config: params.config,
    extraSystemPrompt: incognitoSystemPrompt,
    modelId: options.modelId,
    provider: options.provider,
    sessionKey: params.sessionKey,
    toolsAllow: params.toolsAllow,
  });
  const extraPromptContext =
    runtimeExtraSystemPrompt === params.extraSystemPrompt
      ? readExtraSystemPromptContext(params)
      : readExtraSystemPromptContext(
          copyExtraSystemPromptContext(params, {
            extraSystemPrompt: params.extraSystemPrompt?.trim(),
          }),
        );
  const extraPromptOwner = bindExtraSystemPromptContext(
    { extraSystemPrompt: runtimeExtraSystemPrompt },
    {
      text: runtimeExtraSystemPrompt ?? "",
      reducibleRanges: extraPromptContext?.reducibleRanges ?? [],
    },
  );
  const preparedExtraSystemPrompt = options.prepareAtDispatch
    ? await prepareExtraSystemPrompt(extraPromptOwner, {
        contextTokenBudget: options.contextTokenBudget,
      })
    : undefined;
  return {
    extraPromptOwner,
    preparedExtraSystemPrompt,
    extraSystemPrompt: preparedExtraSystemPrompt?.text ?? extraPromptOwner.extraSystemPrompt,
  };
}
