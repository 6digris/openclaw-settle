import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Text and upload-source aliases shared by Teams message actions. */
export function resolveActionContent(params: Record<string, unknown>): string {
  return typeof params.text === "string"
    ? params.text
    : typeof params.content === "string"
      ? params.content
      : typeof params.message === "string"
        ? params.message
        : "";
}

export function resolveActionUploadFilePath(params: Record<string, unknown>): string | undefined {
  for (const key of ["filePath", "path", "media"] as const) {
    if (typeof params[key] === "string") {
      const value = params[key];
      if (value.trim()) {
        return value;
      }
    }
  }
  return undefined;
}

export {
  readOptionalTrimmedString,
  resolveActionMessageId,
  resolveActionPinnedMessageId,
  resolveActionQuery,
};

function resolveActionMessageId(params: Record<string, unknown>): string {
  return normalizeOptionalString(params.messageId) ?? "";
}

function resolveActionPinnedMessageId(params: Record<string, unknown>): string {
  return typeof params.pinnedMessageId === "string"
    ? params.pinnedMessageId.trim()
    : typeof params.messageId === "string"
      ? params.messageId.trim()
      : "";
}

function resolveActionQuery(params: Record<string, unknown>): string {
  return normalizeOptionalString(params.query) ?? "";
}

function readOptionalTrimmedString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  return normalizeOptionalString(params[key]);
}
