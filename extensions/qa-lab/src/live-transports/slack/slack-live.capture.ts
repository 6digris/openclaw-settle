// QA Lab preserves transient Slack writes; stored history alone cannot prove absence.
import { setTimeout as sleep } from "node:timers/promises";
import type { DebugProxyCaptureReader } from "openclaw/plugin-sdk/proxy-capture";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackObservedMessage } from "./slack-live.contracts.js";

const SLACK_QA_CAPTURE_EVENT_LIMIT = 5_000;
const SLACK_QA_CAPTURE_SETTLE_TIMEOUT_MS = 5_000;
const REPLY_METHODS = new Set([
  "chat.postMessage",
  "chat.update",
  "chat.startStream",
  "chat.appendStream",
  "chat.stopStream",
]);
const METADATA_METHODS = new Set(["agents.sessions.setStatus", "agents.sessions.rename"]);
const CONTENT_FIELDS = new Set([
  "text",
  "markdown_text",
  "title",
  "details",
  "output",
  "fallback",
  "alt_text",
]);

type CaptureEvent = Record<string, unknown>;
type SlackQaWriteObservation = {
  eventId: number;
  flowId?: string;
  method: string;
  classification: "reply" | "metadata" | "other";
  status: "acknowledged" | "rejected" | "unconfirmed";
  content: string[];
  nativeMarkdown?: string;
  message?: SlackObservedMessage;
};
export type SlackQaWriteTrace = {
  // The capture owner records requests after response headers, not at dispatch.
  order: "response-observation";
  complete: boolean;
  issues: string[];
  writes: SlackQaWriteObservation[];
};

function parseObject(payload: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readPayload(store: DebugProxyCaptureReader, event: CaptureEvent): string | undefined {
  // A missing blob is not permission to treat its abbreviated preview as complete.
  if (typeof event.dataBlobId === "string" && event.dataBlobId) {
    return store.readBlob(event.dataBlobId) ?? undefined;
  }
  return typeof event.dataText === "string" ? event.dataText : undefined;
}

function parseRequest(payload: string): Record<string, unknown> | undefined {
  if (payload.trimStart().startsWith("{")) {
    return parseObject(payload);
  }
  return payload.includes("=") ? Object.fromEntries(new URLSearchParams(payload)) : undefined;
}

function readMethod(event: CaptureEvent): string | undefined {
  return event.method === "POST" &&
    event.host === "slack.com" &&
    typeof event.path === "string" &&
    event.path.startsWith("/api/")
    ? event.path.slice("/api/".length).split("?")[0]
    : undefined;
}

function readEvents(params: { sessionId: string; store: DebugProxyCaptureReader }) {
  return params.store.getSessionEvents(params.sessionId, SLACK_QA_CAPTURE_EVENT_LIMIT);
}

export function getSlackQaMessageWriteCursor(params: {
  sessionId: string;
  store: DebugProxyCaptureReader;
}): number {
  // Include standalone transport errors and response rows in the boundary.
  return readEvents(params).reduce(
    (cursor, event) => (typeof event.id === "number" ? Math.max(cursor, event.id) : cursor),
    0,
  );
}

function readContent(request: Record<string, unknown>, issues: string[], eventId: number) {
  const content: string[] = [];
  let nativeMarkdown = typeof request.markdown_text === "string" ? request.markdown_text : "";
  function visit(value: unknown, key?: string) {
    if (typeof value === "string") {
      if (key && CONTENT_FIELDS.has(key) && value.length > 0) {
        content.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
    } else if (isRecord(value)) {
      for (const [field, item] of Object.entries(value)) {
        visit(item, field);
      }
    }
  }
  for (const [key, value] of Object.entries(request)) {
    let parsed = value;
    if (["blocks", "attachments", "chunks"].includes(key) && typeof value === "string") {
      try {
        parsed = JSON.parse(value);
      } catch {
        issues.push(`${eventId}:invalid-${key}`);
      }
    }
    visit(parsed, key);
    if (key === "chunks" && Array.isArray(parsed)) {
      for (const chunk of parsed) {
        if (isRecord(chunk) && chunk.type === "markdown_text" && typeof chunk.text === "string") {
          nativeMarkdown += chunk.text;
        }
      }
    }
  }
  return { content, nativeMarkdown };
}

function incompletePayload(event: CaptureEvent): boolean {
  if (event.metaJson === undefined || event.metaJson === null) {
    return false;
  }
  const meta = typeof event.metaJson === "string" ? parseObject(event.metaJson) : undefined;
  return !meta || meta.captureTruncated === true || typeof meta.bodyCapture === "string";
}

function collectTrace(params: {
  afterRequestEventId: number;
  events: CaptureEvent[];
  store: DebugProxyCaptureReader;
}) {
  const issues: string[] = [];
  if (params.events.length >= SLACK_QA_CAPTURE_EVENT_LIMIT) {
    issues.push("capture-window-limit");
  }
  const terminalByFlow = new Map<string, CaptureEvent>();
  for (const event of params.events) {
    if ((event.kind === "response" || event.kind === "error") && typeof event.flowId === "string") {
      terminalByFlow.set(event.flowId, event);
    }
  }
  let settled = true;
  const writes: SlackQaWriteObservation[] = [];
  const events = params.events
    .filter(
      (event) =>
        typeof event.id === "number" &&
        event.id > params.afterRequestEventId &&
        (event.kind === "request" || event.kind === "error") &&
        readMethod(event),
    )
    .toSorted((a, b) => Number(a.id) - Number(b.id));
  for (const event of events) {
    const eventId = Number(event.id);
    const method = readMethod(event)!;
    const classification = REPLY_METHODS.has(method)
      ? "reply"
      : METADATA_METHODS.has(method)
        ? "metadata"
        : "other";
    const flowId = typeof event.flowId === "string" ? event.flowId : undefined;
    if (event.kind === "error") {
      issues.push(`${eventId}:transport-error`);
      writes.push({ eventId, flowId, method, classification, status: "unconfirmed", content: [] });
      continue;
    }
    const terminal = flowId ? terminalByFlow.get(flowId) : undefined;
    const requestPayload = readPayload(params.store, event);
    const request = requestPayload ? parseRequest(requestPayload) : undefined;
    const responsePayload = terminal ? readPayload(params.store, terminal) : undefined;
    const response = responsePayload ? parseObject(responsePayload) : undefined;
    const status =
      terminal?.kind === "response" && terminal.status === 200 && response?.ok === true
        ? "acknowledged"
        : terminal && response
          ? "rejected"
          : "unconfirmed";
    if (!terminal) {
      settled = false;
    }
    if (!request || incompletePayload(event)) {
      issues.push(`${eventId}:incomplete-request`);
    }
    if (!terminal || incompletePayload(terminal) || !response) {
      issues.push(`${eventId}:incomplete-response`);
    }
    if (status !== "acknowledged") {
      issues.push(`${eventId}:${status}`);
    }
    const { content, nativeMarkdown } = request
      ? readContent(request, issues, eventId)
      : { content: [], nativeMarkdown: "" };
    const channelId = response?.channel ?? request?.channel;
    const ts = response?.ts ?? request?.ts;
    const text = typeof request?.text === "string" ? request.text : "";
    const message =
      classification === "reply" &&
      status === "acknowledged" &&
      typeof channelId === "string" &&
      typeof ts === "string"
        ? {
            channelId,
            text,
            ts,
            ...(content.some((value) => value !== text)
              ? { blockText: content.filter((value) => value !== text) }
              : {}),
            ...(typeof request?.thread_ts === "string" ? { threadTs: request.thread_ts } : {}),
          }
        : undefined;
    writes.push({
      eventId,
      flowId,
      method,
      classification,
      status,
      content,
      ...(classification === "reply" && method.endsWith("Stream") ? { nativeMarkdown } : {}),
      ...(message ? { message } : {}),
    });
  }
  return {
    settled,
    trace: {
      order: "response-observation" as const,
      complete: issues.length === 0,
      issues,
      writes,
    },
  };
}

/** Read after an awaited turn/delivery boundary; settling capture cannot establish turn completion. */
export async function readSlackQaWriteTrace(params: {
  afterRequestEventId: number;
  sessionId: string;
  settleTimeoutMs?: number;
  store: DebugProxyCaptureReader;
}): Promise<SlackQaWriteTrace> {
  const deadline = Date.now() + (params.settleTimeoutMs ?? SLACK_QA_CAPTURE_SETTLE_TIMEOUT_MS);
  while (true) {
    const result = collectTrace({ ...params, events: readEvents(params) });
    if (result.settled || Date.now() >= deadline) {
      return result.trace;
    }
    await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

export async function readSlackQaMessageWrites(
  params: Parameters<typeof readSlackQaWriteTrace>[0],
): Promise<SlackObservedMessage[]> {
  const trace = await readSlackQaWriteTrace(params);
  return trace.writes.flatMap((write) => (write.message ? [write.message] : []));
}
