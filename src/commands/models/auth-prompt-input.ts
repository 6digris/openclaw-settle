/** Prompt and stdin helpers for model auth commands. */
import {
  cancel,
  confirm as clackConfirm,
  isCancel,
  password as clackPassword,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { styleSelectParams } from "../../../packages/terminal-core/src/prompt-select-styled-params.js";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";

const MODELS_AUTH_STDIN_MAX_BYTES = 1024 * 1024;

export function resolveManualTokenExpiryMs(expiresIn: string | undefined): number | undefined {
  const normalizedExpiresIn = normalizeStringifiedOptionalString(expiresIn);
  if (!normalizedExpiresIn) {
    return undefined;
  }
  const durationMs = parseDurationMs(normalizedExpiresIn, { defaultUnit: "d" });
  const expires = resolveExpiresAtMsFromDurationMs(durationMs);
  if (expires === undefined) {
    throw new Error("Invalid expiry duration: resulting token expiry is outside Date range.");
  }
  return expires;
}

function guardCancel<T>(value: T | symbol): T {
  if (typeof value === "symbol" || isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value;
}

export const confirmModelAuthPrompt = async (params: Parameters<typeof clackConfirm>[0]) =>
  guardCancel(
    await clackConfirm({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );

export const textModelAuthPrompt = async (params: Parameters<typeof clackText>[0]) =>
  guardCancel(
    await clackText({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );

const password = async (params: Parameters<typeof clackPassword>[0]) =>
  guardCancel(
    await clackPassword({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );

export const selectModelAuthPrompt = async <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  guardCancel(await clackSelect(styleSelectParams(params)));

async function readPipedStdin(): Promise<string> {
  const bytes = await readByteStreamWithLimit(process.stdin, {
    maxBytes: MODELS_AUTH_STDIN_MAX_BYTES,
    onOverflow: ({ maxBytes }) => new Error(`Piped auth input exceeds ${maxBytes} bytes.`),
  });
  return bytes.toString("utf8");
}

export async function readPastedSecret(params: {
  message: string;
  masked: boolean;
  validate?: (value: string | undefined) => string | undefined;
}): Promise<string> {
  const promptParams = { message: params.message, validate: params.validate };
  const input = process.stdin.isTTY
    ? await (params.masked ? password(promptParams) : textModelAuthPrompt(promptParams))
    : await readPipedStdin();
  const normalized = normalizeSecretInput(input);
  const validationMessage = params.validate?.(normalized);
  if (validationMessage) {
    throw new Error(validationMessage);
  }
  return normalized;
}
