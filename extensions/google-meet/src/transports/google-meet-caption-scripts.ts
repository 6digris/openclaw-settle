import { normalizeMeetUrlForReuse } from "./google-meet-urls.js";
import { GOOGLE_MEET_TRANSCRIPT_MAX_LINES } from "./types.js";

// Status observation and explicit final capture share the same line-commit owner.
export const CAPTION_LINE_COMMIT_SOURCE = `
  const captionLine = (entry) => ({
    at: entry.at,
    speaker: entry.speaker,
    text: entry.text,
    ...(entry.source ? { source: { ...entry.source } } : {})
  });
  const rememberCaptionSource = (state, entry) => {
    if (!entry.source || !state.sourceHistory) return;
    state.sourceRevisions?.set(entry.source.id, Math.max(state.sourceRevisions.get(entry.source.id) || 0, Number(entry.source.revision)));
    const key = entry.text;
    if (state.sourceHistory.has(key) || state.sourceHistory.size < ${GOOGLE_MEET_TRANSCRIPT_MAX_LINES}) {
      state.sourceHistory.set(key, { ...entry.source });
    }
  };
  const reviseCaptionSource = (state, entry, changes) => {
    if (!entry.source) return;
    const revision = Number(entry.source.revision);
    if (revision < (state.sourceRevisions?.get(entry.source.id) || 0)) {
      entry.source = undefined;
      return;
    }
    entry.source = { ...entry.source, ...changes, revision: String(revision + 1) };
  };
  const commitLines = (state, entries) => {
    state.lines = Array.isArray(state.lines) ? state.lines : [];
    for (const entry of entries) {
      if (entry.source && Number(entry.source.revision) < (state.sourceRevisions?.get(entry.source.id) || 0)) entry.source = undefined;
      if (entry.source && !entry.source.finalized) {
        reviseCaptionSource(state, entry, { finalized: true });
      }
      rememberCaptionSource(state, entry);
      state.lines.push(captionLine(entry));
    }
    const excess = state.lines.length - ${GOOGLE_MEET_TRANSCRIPT_MAX_LINES};
    if (excess > 0) {
      state.lines.splice(0, excess);
      state.droppedLines = (state.droppedLines || 0) + excess;
    }
  };
`;

export function meetTranscriptScript(
  meetingUrl: string,
  meetingSessionId: string,
  finalize: boolean,
) {
  const expectedMeetingUrl = normalizeMeetUrlForReuse(meetingUrl);
  return `() => {
  const expectedMeetingUrl = ${JSON.stringify(expectedMeetingUrl)};
  const expectedSessionId = ${JSON.stringify(meetingSessionId)};
  let currentMeetingUrl;
  try {
    const currentUrl = new URL(location.href);
    currentMeetingUrl = currentUrl.origin + currentUrl.pathname.toLowerCase().replace(/\\/$/, "");
  } catch {
    return JSON.stringify({ urlMatched: false });
  }
  if (!expectedMeetingUrl || currentMeetingUrl !== expectedMeetingUrl) {
    return JSON.stringify({ urlMatched: false });
  }
  const state = window.__openclawMeetCaptions;
  ${CAPTION_LINE_COMMIT_SOURCE}
  if (state?.sessionId && state.sessionId !== expectedSessionId) {
    return JSON.stringify({ urlMatched: true, sessionMatched: false });
  }
  if (${JSON.stringify(finalize)} && Array.isArray(state?.visible) && state.visible.length > 0) {
    if (state.settleTimer !== undefined) clearTimeout(state.settleTimer);
    state.settleTimer = undefined;
    commitLines(state, state.visible);
    state.visible = [];
  }
  const lines = Array.isArray(state?.lines) ? state.lines : [];
  return JSON.stringify({
    urlMatched: true,
    sessionMatched: true,
    epoch: typeof state?.epoch === "string" ? state.epoch : undefined,
    droppedLines: Number.isFinite(state?.droppedLines) ? Math.max(0, Math.trunc(state.droppedLines)) : 0,
    lines: lines.map((line) => ({
      at: typeof line?.at === "string" ? line.at : undefined,
      speaker: typeof line?.speaker === "string" ? line.speaker : undefined,
      text: typeof line?.text === "string" ? line.text : "",
      ...(line?.source ? { source: { ...line.source } } : {})
    })).filter((line) => line.text),
    pendingLines: (Array.isArray(state?.visible) ? state.visible : []).map(captionLine)
  });
}`;
}
