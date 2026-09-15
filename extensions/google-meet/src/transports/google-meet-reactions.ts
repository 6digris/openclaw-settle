import type {
  MeetingBrowserParticipationAdapter,
  MeetingParticipationSource,
} from "openclaw/plugin-sdk/meeting-runtime";
import { meetParticipationSourceCheck } from "./google-meet-source-check.js";
import { normalizeMeetUrlForReuse } from "./google-meet-urls.js";

const MEET_REACTIONS = ["💖", "👍", "🎉", "👏", "😂", "😮", "😢", "🤔", "👎"] as const;

function reactionPageSource(params: {
  meetingSessionId: string;
  meetingUrl: string;
  source?: MeetingParticipationSource;
}): string {
  const { meetingSessionId, meetingUrl } = params;
  return `
      ${meetParticipationSourceCheck(params)}
      const sessionId = ${JSON.stringify(meetingSessionId)};
      const expectedUrl = ${JSON.stringify(normalizeMeetUrlForReuse(meetingUrl))};
      const knownReactions = ${JSON.stringify(MEET_REACTIONS)};
      const label = (node) => node.getAttribute('aria-label') || '';
      const visible = (node) => {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        return node.isConnected && rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden';
      };
      const enabled = (node) => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
      const current = () => {
        const url = new URL(location.href);
        return Boolean(expectedUrl && sourceCurrent() && window.__openclawMeetAudioSession === sessionId &&
          url.origin + url.pathname.toLowerCase().replace(/[/]$/, '') === expectedUrl &&
          [...document.querySelectorAll('button')].some((node) =>
            node.isConnected && /^Leave call(?:\\s|\\(|$)/i.test(label(node))));
      };
      const pickers = () => {
        // Current Meet nests a same-named toolbar inside its dialog. That pair is
        // one palette; only use a standalone toolbar when no visible dialog exists.
        const dialogs = [...document.querySelectorAll('[role="dialog"][aria-label="Send a reaction"]')].filter(visible);
        return dialogs.length > 0 ? dialogs
          : [...document.querySelectorAll('[role="toolbar"][aria-label="Send a reaction"]')].filter(visible);
      };
      const choices = () => {
        const roots = pickers();
        return roots.length === 1
          ? [...roots[0].querySelectorAll('button[data-emoji]')].filter(enabled)
          : [];
      };
      const supported = () => [...new Set(choices().map((node) => node.getAttribute('data-emoji')))]
        .filter((value) => knownReactions.includes(value));
      const wait = () => new Promise((resolve) => setTimeout(resolve, 100));
  `;
}

function readReactionResult(result: unknown): Record<string, unknown> | undefined {
  if (
    !result ||
    typeof result !== "object" ||
    !("result" in result) ||
    ("ok" in result && result.ok !== true)
  )
    return undefined;
  try {
    const parsed: unknown =
      typeof result.result === "string" ? JSON.parse(result.result) : result.result;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export const GOOGLE_MEET_REACTIONS_ADAPTER = {
  capabilities: ["reaction.send"],
  validateAction(action) {
    if (
      action.type !== "reaction.send" ||
      typeof action.emoji !== "string" ||
      action.emoji.length === 0 ||
      action.emoji.length > 16 ||
      Object.keys(action).some((key) => key !== "type" && key !== "emoji")
    ) {
      return "A reaction requires only type: reaction.send and a single emoji from the Meet palette.";
    }
    return undefined;
  },
  buildPreparationScript(params) {
    return `async () => {
      ${reactionPageSource(params)}
      const result = (status, message) => JSON.stringify({ status, message });
      const stale = () => result('rejected', 'The meeting session or original request is no longer current.');
      try {
        if (!current()) return stale();
        if (pickers().length === 0) {
          const findToggle = () => [...document.querySelectorAll('button[aria-label]')]
            .filter((node) => enabled(node) && label(node) === 'Send a reaction');
          let toggles = findToggle();
          if (toggles.length === 0) {
            // Meet hides its toolbar while idle. Wake it without clicking another
            // control or changing focus, then rediscover the native reaction button.
            const x = Math.max(1, Math.floor(window.innerWidth / 2));
            const y = Math.max(1, window.innerHeight - 24);
            const target = document.elementFromPoint(x, y) || document.documentElement;
            if (!current()) return stale();
            target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerType: 'mouse' }));
            if (!current()) return stale();
            target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
            await wait();
            if (!current()) return stale();
            toggles = findToggle();
          }
          if (toggles.length !== 1) return result('unsupported', 'The native Meet reaction palette is unavailable.');
          if (!current()) return stale();
          toggles[0].click();
          for (let attempt = 0; attempt < 10 && pickers().length === 0; attempt++) {
            await wait();
            if (!current()) return stale();
          }
        }
        if (!current()) return stale();
        return pickers().length === 1
          ? JSON.stringify({ status: 'prepared' })
          : result('unsupported', 'The native Meet reaction palette is unavailable.');
      } catch {
        return result('failed', 'The native Meet reaction palette could not be prepared.');
      }
    }`;
  },
  parsePreparationResult(result) {
    const parsed = readReactionResult(result);
    if (parsed?.status === "prepared") return { status: "succeeded" };
    const status = parsed?.status;
    return {
      status: status === "rejected" || status === "unsupported" ? status : "failed",
      message:
        typeof parsed?.message === "string"
          ? parsed.message
          : "The native Meet reaction palette could not be prepared.",
    };
  },
  buildActionScript({ meetingSessionId, meetingUrl, action, source }) {
    return `async () => {
      ${reactionPageSource({ meetingSessionId, meetingUrl, source })}
      const emoji = ${JSON.stringify(action.emoji)};
      let sent = false;
      let observer;
      const result = (status, message, extra = {}, correctable = false) => JSON.stringify({
        status, message, ...(correctable ? { correctable: true } : {}),
        observed: { supportedReactions: supported(), ...extra }
      });
      const stale = () => result(sent ? 'uncertain' : 'rejected',
        'The meeting session or original request is no longer current.');
      try {
        if (!current()) return stale();
        if (!current()) return stale();
        if (pickers().length !== 1 || supported().length === 0) {
          return result('unsupported', 'The native Meet reaction palette is unavailable.');
        }
        const matches = choices().filter((node) => node.getAttribute('data-emoji') === emoji);
        if (!knownReactions.includes(emoji) || matches.length !== 1) {
          return result('rejected', 'That emoji is not available in the native Meet reaction palette.', {}, true);
        }

        // A click alone is not a receipt. Observe only Meet's own fresh accessibility
        // announcement; preexisting text and moving an old region cannot confirm it.
        const selector = '[aria-live="polite"][data-mdc-dom-announce="true"]';
        const knownRegions = new WeakSet(document.querySelectorAll(selector));
        let confirmed = false;
        observer = new MutationObserver((records) => {
          const touched = new Set();
          const added = (region) => {
            if (!knownRegions.has(region)) {
              knownRegions.add(region);
              touched.add(region);
            }
          };
          for (const record of records) {
            const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            const region = element?.closest?.(selector);
            if (region) {
              knownRegions.add(region);
              touched.add(region);
            }
            for (const node of record.addedNodes || []) {
              if (node.nodeType !== 1) continue;
              if (node.matches(selector)) added(node);
              for (const region of node.querySelectorAll(selector)) added(region);
            }
          }
          confirmed ||= [...touched].some((region) =>
            region.isConnected && region.textContent.trim() === 'You reacted with ' + emoji + '.');
        });
        observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
        if (!current()) return stale();
        if (!enabled(matches[0]) || !choices().includes(matches[0])) {
          return result('rejected', 'The native Meet reaction control changed before sending.');
        }
        // Discard queued announcements from before the click without an intervening
        // await. Request replay/correction admission belongs to the session runtime.
        for (const region of document.querySelectorAll(selector)) knownRegions.add(region);
        observer.takeRecords();
        if (!current()) return stale();
        sent = true;
        matches[0].click();
        for (let attempt = 0; attempt < 10; attempt++) {
          await wait();
          if (!current()) return stale();
          if (confirmed) return result('succeeded', undefined, { emoji, confirmation: 'native_reaction_announcement' });
        }
        return result('uncertain', 'Meet did not confirm this reaction; do not resend it automatically.', { emoji });
      } catch {
        return result(sent ? 'uncertain' : 'failed', 'The native Meet reaction could not be confirmed.');
      } finally {
        observer?.disconnect();
      }
    }`;
  },
  parseActionResult(result) {
    const uncertain = {
      status: "uncertain" as const,
      message: "Meet returned an invalid reaction receipt; do not resend it automatically.",
    };
    try {
      const parsed = readReactionResult(result);
      if (!parsed) return uncertain;
      const { status } = parsed;
      if (
        status !== "succeeded" &&
        status !== "failed" &&
        status !== "uncertain" &&
        status !== "unsupported" &&
        status !== "rejected"
      ) {
        return uncertain;
      }
      const observed = "observed" in parsed ? parsed.observed : undefined;
      if (
        !observed ||
        typeof observed !== "object" ||
        !("supportedReactions" in observed) ||
        !Array.isArray(observed.supportedReactions) ||
        observed.supportedReactions.length > MEET_REACTIONS.length ||
        observed.supportedReactions.some(
          (value) => !MEET_REACTIONS.some((emoji) => emoji === value),
        )
      ) {
        return uncertain;
      }
      const emoji =
        "emoji" in observed &&
        typeof observed.emoji === "string" &&
        MEET_REACTIONS.some((value) => value === observed.emoji)
          ? observed.emoji
          : undefined;
      const confirmation = "confirmation" in observed ? observed.confirmation : undefined;
      if (status === "succeeded" && (!emoji || confirmation !== "native_reaction_announcement")) {
        return uncertain;
      }
      return {
        status,
        ...(status === "rejected" && "correctable" in parsed && parsed.correctable === true
          ? { correctable: true as const }
          : {}),
        message:
          "message" in parsed && typeof parsed.message === "string" ? parsed.message : undefined,
        observed: {
          supportedReactions: [...new Set(observed.supportedReactions)],
          ...(emoji ? { emoji } : {}),
          ...(confirmation === "native_reaction_announcement" ? { confirmation } : {}),
        },
      };
    } catch {
      return uncertain;
    }
  },
} satisfies MeetingBrowserParticipationAdapter;
