import { runInNewContext } from "node:vm";
import type { MeetingParticipationSource } from "openclaw/plugin-sdk/meeting-runtime";
import { vi } from "vitest";
import { GOOGLE_MEET_REACTIONS_ADAPTER } from "../transports/google-meet-reactions.js";

export const MEETING_URL = "https://meet.google.com/abc-defg-hij";
export const EMOJIS = ["💖", "👍", "🎉", "👏", "😂", "😮", "😢", "🤔", "👎"];
const ANNOUNCEMENT = '[aria-live="polite"][data-mdc-dom-announce="true"]';

export class Element {
  readonly nodeType = 1;
  isConnected = true;
  disabled = false;
  hidden = false;
  textContent = "";
  parentElement?: Element;
  children: Element[] = [];
  click = vi.fn<() => void>();
  dispatchEvent = vi.fn<(event: { type: string }) => boolean>(() => true);

  constructor(
    readonly tag: string,
    readonly attributes: Record<string, string> = {},
  ) {}

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  getBoundingClientRect() {
    let hidden = this.hidden;
    for (let parent = this.parentElement; parent; parent = parent.parentElement)
      hidden ||= parent.hidden;
    return { width: hidden ? 0 : 10, height: hidden ? 0 : 10 };
  }

  append(node: Element) {
    node.parentElement = this;
    this.children.push(node);
  }

  matches(selector: string): boolean {
    if (selector.includes(","))
      return selector.split(",").some((part) => this.matches(part.trim()));
    switch (selector) {
      case "button":
        return this.tag === "button";
      case "button[aria-label]":
        return this.tag === "button" && "aria-label" in this.attributes;
      case "button[data-emoji]":
        return this.tag === "button" && "data-emoji" in this.attributes;
      case 'textarea[aria-label="Send a message"]':
      case 'textarea[placeholder="Send a message"]':
      case '[role="textbox"][aria-label="Send a message"]':
        return false;
      case ".RLrADb[data-message-id]":
        return this.hasClass("RLrADb") && "data-message-id" in this.attributes;
      case ".aops0b":
      case ".HNucUd":
      case ".poVWob":
        return this.hasClass(selector.slice(1));
      case ".jO4O1.chmVPb":
        return this.hasClass("jO4O1") && this.hasClass("chmVPb");
      case ".jO4O1:not(.chmVPb)":
        return this.hasClass("jO4O1") && !this.hasClass("chmVPb");
      case 'div[jsname="dTKtvb"]':
        return this.tag === "div" && this.attributes.jsname === "dTKtvb";
      case '[role="dialog"][aria-label="Send a reaction"]':
        return (
          this.attributes.role === "dialog" && this.attributes["aria-label"] === "Send a reaction"
        );
      case '[role="toolbar"][aria-label="Send a reaction"]':
        return (
          this.attributes.role === "toolbar" && this.attributes["aria-label"] === "Send a reaction"
        );
      case ANNOUNCEMENT:
        return (
          this.attributes["aria-live"] === "polite" &&
          this.attributes["data-mdc-dom-announce"] === "true"
        );
      default:
        throw new Error(`Unexpected native selector: ${selector}`);
    }
  }

  hasClass(name: string) {
    return (this.attributes.class ?? "").split(" ").includes(name);
  }

  querySelector(selector: string): Element | undefined {
    return this.querySelectorAll(selector)[0];
  }

  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((node) => [
      ...(node.isConnected && node.matches(selector) ? [node] : []),
      ...node.querySelectorAll(selector),
    ]);
  }

  closest(selector: string): Element | undefined {
    return this.matches(selector) ? this : this.parentElement?.closest(selector);
  }
}

type Mutation = { target: Element; addedNodes: Element[] };

export function reactionPage(
  options: {
    open?: boolean;
    receipt?: boolean;
    available?: string[];
    legacyDialog?: boolean;
    standaloneToolbar?: boolean;
  } = {},
) {
  const root = new Element("html");
  type CaptionEntry = { text: string; source: MeetingParticipationSource };
  const window: {
    __openclawMeetAudioSession: string;
    innerWidth: number;
    innerHeight: number;
    __openclawMeetCaptions?: {
      sessionId: string;
      epoch: string;
      sourceRevisions: Map<string, number>;
      lines: CaptionEntry[];
      visible: CaptionEntry[];
    };
    __openclawMeetChat?: {
      sessionId: string;
      epoch: string;
      messages: Map<string, MeetingParticipationSource & { historical: boolean }>;
    };
  } = { __openclawMeetAudioSession: "session-1", innerWidth: 1280, innerHeight: 720 };
  const location = { href: `${MEETING_URL}?hl=en&authuser=1` };
  const leave = new Element("button", { "aria-label": "Leave call" });
  const microphone = new Element("button", { "aria-label": "Turn on microphone" });
  const hand = new Element("button", { "aria-label": "Raise hand" });
  const toggle = new Element("button", {
    "aria-label": "Send a reaction",
    "aria-haspopup": "dialog",
    "aria-pressed": String(options.open !== false),
    "aria-expanded": String(options.open !== false),
  });
  const picker = new Element("div", {
    role: options.standaloneToolbar ? "toolbar" : "dialog",
    "aria-orientation": "horizontal",
    "aria-label": "Send a reaction",
  });
  picker.hidden = options.open === false;
  const toolbar = new Element("div", {
    role: "toolbar",
    "aria-orientation": "horizontal",
    "aria-label": "Send a reaction",
  });
  if (!options.legacyDialog && !options.standaloneToolbar) picker.append(toolbar);
  for (const node of [leave, microphone, hand, toggle, picker]) root.append(node);
  let callback: ((records: Mutation[]) => void) | undefined;
  let pending: Mutation[] = [];
  let observed = false;
  let onWait: (() => void) | undefined;
  let onObserve: (() => void) | undefined;
  const disconnect = vi.fn(() => {
    observed = false;
  });
  const flush = () => {
    if (!observed || pending.length === 0) return;
    const records = pending;
    pending = [];
    callback?.(records);
  };
  const notify = (record: Mutation) => {
    if (!observed) return;
    pending.push(record);
    queueMicrotask(flush);
  };
  const announce = (text: string, existing?: Element) => {
    const region =
      existing ??
      new Element("div", {
        "aria-live": "polite",
        "data-mdc-dom-announce": "true",
      });
    region.textContent = text;
    if (!existing) root.append(region);
    notify({ target: existing ?? root, addedNodes: existing ? [] : [region] });
    return region;
  };
  const buttons = (options.available ?? EMOJIS).map((emoji) => {
    const button = new Element("button", { "data-emoji": emoji, "aria-label": emoji });
    button.click.mockImplementation(() => {
      if (options.receipt !== false) announce(`You reacted with ${emoji}.`);
    });
    (options.legacyDialog || options.standaloneToolbar ? picker : toolbar).append(button);
    return button;
  });
  toggle.click.mockImplementation(() => {
    picker.hidden = false;
    toggle.attributes["aria-pressed"] = "true";
    toggle.attributes["aria-expanded"] = "true";
  });
  const evaluate = async (fn: string) => {
    const result: unknown = await runInNewContext(`(${fn})()`, {
      URL,
      window,
      location,
      PointerEvent: class {
        constructor(readonly type: string) {}
      },
      MouseEvent: class {
        constructor(readonly type: string) {}
      },
      document: {
        documentElement: root,
        elementFromPoint: () => root,
        querySelectorAll: (selector: string) => root.querySelectorAll(selector),
      },
      getComputedStyle: (node: Element) => ({
        display: node.hidden ? "none" : "block",
        visibility: "visible",
      }),
      MutationObserver: class {
        constructor(next: (records: Mutation[]) => void) {
          callback = next;
        }
        observe() {
          observed = true;
          onObserve?.();
        }
        takeRecords() {
          const records = pending;
          pending = [];
          return records;
        }
        disconnect = disconnect;
      },
      setTimeout: (next: () => void) =>
        queueMicrotask(() => {
          onWait?.();
          flush();
          next();
        }),
    });
    return { ok: true, result };
  };
  const run = async (emoji = "👍") => {
    const params = {
      meetingSessionId: "session-1",
      meetingUrl: MEETING_URL,
      requestId: "request-1",
      action: { type: "reaction.send", emoji },
    };
    const prepare = GOOGLE_MEET_REACTIONS_ADAPTER.buildPreparationScript?.(params);
    if (!prepare || !GOOGLE_MEET_REACTIONS_ADAPTER.parsePreparationResult)
      throw new Error("Expected reaction preparation");
    const prepared = GOOGLE_MEET_REACTIONS_ADAPTER.parsePreparationResult(await evaluate(prepare));
    if (prepared.status !== "succeeded") return prepared;
    return GOOGLE_MEET_REACTIONS_ADAPTER.parseActionResult(
      await evaluate(GOOGLE_MEET_REACTIONS_ADAPTER.buildActionScript(params)),
    );
  };
  const setCaptionSource = (source: MeetingParticipationSource) => {
    const captions = {
      sessionId: "session-1",
      epoch: source.epoch,
      sourceRevisions: new Map([[source.id, Number(source.revision)]]),
      lines: [{ text: source.text, source: { ...source } }],
      visible: [],
    };
    window.__openclawMeetCaptions = captions;
    return captions;
  };
  const setChatSource = (source: MeetingParticipationSource) => {
    window.__openclawMeetChat = {
      sessionId: "session-1",
      epoch: source.epoch,
      messages: new Map([[source.id, { ...source, historical: false }]]),
    };
    const group = new Element("div", { class: "aops0b" });
    const header = new Element("div", { class: "HNucUd" });
    const sender = new Element("span", { class: "poVWob" });
    sender.textContent = "Participant";
    header.append(sender);
    group.append(header);
    const row = new Element("div", { class: "RLrADb", "data-message-id": source.id });
    const content = new Element("div", { class: "jO4O1" });
    const body = new Element("div", { jsname: "dTKtvb" });
    body.textContent = source.text;
    content.append(body);
    row.append(content);
    group.append(row);
    root.append(group);
    return { row, content, body };
  };
  return {
    root,
    picker,
    toggle,
    leave,
    microphone,
    hand,
    buttons,
    window,
    location,
    disconnect,
    run,
    evaluate,
    announce,
    notify,
    setCaptionSource,
    setChatSource,
    beforeWait(next: () => void) {
      onWait = next;
    },
    beforeObserve(next: () => void) {
      onObserve = next;
    },
  };
}
