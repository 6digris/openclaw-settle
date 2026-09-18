import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const CODEX_APP_SERVER_PARSE_LOG_MAX = 500;
const CODEX_APP_SERVER_PARSE_BUFFER_MAX = 8 * 1024 * 1024;
const CODEX_APP_SERVER_PARSE_BUFFER_MAX_LINES = 1_000;

/** Owns JSONL decoding and bounded recovery of raw newlines inside JSON strings. */
export class CodexAppServerLineParser {
  private pendingParse:
    | { text: string; lineCount: number; unterminatedString: boolean }
    | undefined;

  constructor(private readonly onMessage: (message: unknown) => void) {}

  close(): void {
    this.pendingParse = undefined;
  }

  handleLine(line: string): void {
    // Live RPC values remain exact; the canonical presentation boundary redacts diagnostics.
    const rawLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (this.pendingParse) {
      this.handlePendingParseLine(rawLine);
      return;
    }
    const trimmed = rawLine.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      if (shouldBufferCodexAppServerParseFailure(trimmed, error)) {
        this.pendingParse = {
          text: trimmed,
          lineCount: 1,
          unterminatedString: isUnterminatedString(error),
        };
        return;
      }
      logCodexAppServerParseFailure(trimmed, error, 1);
      return;
    }
    this.onMessage(parsed);
  }

  private handlePendingParseLine(line: string): void {
    const pending = this.pendingParse;
    if (!pending) {
      return;
    }
    const candidate = `${pending.text}\\n${line}`;
    const lineCount = pending.lineCount + 1;
    const withinLimit =
      candidate.length <= CODEX_APP_SERVER_PARSE_BUFFER_MAX &&
      lineCount <= CODEX_APP_SERVER_PARSE_BUFFER_MAX_LINES;
    // A plain fragment cannot close an unterminated JSON string or introduce a
    // syntax error. Keep the rope unflattened until a delimiter needs parsing.
    if (pending.unterminatedString && withinLimit && !/["\\\p{Cc}]/u.test(line)) {
      this.pendingParse = { text: candidate, lineCount, unterminatedString: true };
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      if (shouldBufferCodexAppServerParseFailure(candidate.trim(), error) && withinLimit) {
        this.pendingParse = {
          text: candidate,
          lineCount,
          unterminatedString: isUnterminatedString(error),
        };
        return;
      }
      this.pendingParse = undefined;
      logCodexAppServerParseFailure(candidate, error, lineCount);
      return;
    }
    this.pendingParse = undefined;
    this.onMessage(parsed);
  }
}

export function redactCodexAppServerLinePreview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const redacted = compact
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1<redacted>")
    .replace(
      /("(?:api_?key|authorization|token|access_token|refresh_token)"\s*:\s*")([^"]+)(")/gi,
      "$1<redacted>$3",
    )
    .replace(
      /\b([a-z0-9_]*(?:api_?key|authorization|access_token|refresh_token|token))(\s*=\s*)(["']?)[^\s"']+(\3)/gi,
      "$1$2$3<redacted>$4",
    );
  return redacted.length > CODEX_APP_SERVER_PARSE_LOG_MAX
    ? `${truncateUtf16Safe(redacted, CODEX_APP_SERVER_PARSE_LOG_MAX)}...`
    : redacted;
}

function isUnterminatedString(error: unknown): boolean {
  return coerceErrorMessage(error).includes("Unterminated string");
}

// Codex has emitted JSON with raw newlines inside string values, which breaks
// line framing. Buffer the fragments and re-join with an escaped newline so
// the message parses; bounded by CODEX_APP_SERVER_PARSE_BUFFER_MAX*.
function shouldBufferCodexAppServerParseFailure(value: string, error: unknown): boolean {
  if (!value.startsWith("{") && !value.startsWith("[")) {
    return false;
  }
  const message = coerceErrorMessage(error);
  return (
    message.includes("Unterminated string") || message.includes("Unexpected end of JSON input")
  );
}

function logCodexAppServerParseFailure(value: string, error: unknown, fragmentCount: number): void {
  const linePreview = redactCodexAppServerLinePreview(value);
  const suffix = fragmentCount > 1 ? ` fragments=${fragmentCount}` : "";
  embeddedAgentLog.warn("failed to parse codex app-server message", {
    error,
    errorMessage: coerceErrorMessage(error),
    fragmentCount,
    linePreview,
    consoleMessage: `failed to parse codex app-server message${suffix}: preview=${JSON.stringify(
      linePreview,
    )}`,
  });
}
