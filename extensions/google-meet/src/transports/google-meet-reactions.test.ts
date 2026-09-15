import { describe, expect, it } from "vitest";
import {
  Element,
  EMOJIS,
  MEETING_URL,
  reactionPage,
} from "../test-support/reaction-page.test-helpers.js";
import { GOOGLE_MEET_REACTIONS_ADAPTER } from "./google-meet-reactions.js";

describe("native Meet reactions", () => {
  const actionParams = {
    meetingSessionId: "session-1",
    meetingUrl: MEETING_URL,
    requestId: "request-1",
    action: { type: "reaction.send", emoji: "👍" },
  };

  it("prepares the palette without sending a reaction", async () => {
    const page = reactionPage({ open: false });
    const source = GOOGLE_MEET_REACTIONS_ADAPTER.buildPreparationScript?.(actionParams);
    if (!source) throw new Error("Expected reaction preparation");
    const result = await page.evaluate(source);
    expect(GOOGLE_MEET_REACTIONS_ADAPTER.parsePreparationResult?.(result)).toEqual({
      status: "succeeded",
    });
    expect(page.toggle.click).toHaveBeenCalledOnce();
    expect(page.buttons.every((node) => node.click.mock.calls.length === 0)).toBe(true);
  });

  it("does not open or wait for a palette in the final action phase", async () => {
    const page = reactionPage({ open: false });
    const result = await page.evaluate(
      GOOGLE_MEET_REACTIONS_ADAPTER.buildActionScript(actionParams),
    );
    expect(GOOGLE_MEET_REACTIONS_ADAPTER.parseActionResult(result)).toMatchObject({
      status: "unsupported",
    });
    expect(page.toggle.click).not.toHaveBeenCalled();
    expect(page.root.dispatchEvent).not.toHaveBeenCalled();
    expect(page.buttons.every((node) => node.click.mock.calls.length === 0)).toBe(true);
  });

  it("performs the final guarded click before the first asynchronous yield", async () => {
    const page = reactionPage();
    const result = page.evaluate(GOOGLE_MEET_REACTIONS_ADAPTER.buildActionScript(actionParams));
    expect(page.buttons[1].click).toHaveBeenCalledOnce();
    await result;
  });

  it.each(["chat", "caption"] as const)(
    "requires a still-current native %s source before clicking",
    async (kind) => {
      const source: MeetingParticipationSource = {
        id: "source-1",
        epoch: "epoch-1",
        revision: "1",
        kind,
        text: "Please react with a thumbs up.",
        finalized: true,
        ownEcho: false,
      };
      const page = reactionPage();
      const chat = kind === "chat" ? page.setChatSource(source) : undefined;
      const captions = kind === "caption" ? page.setCaptionSource(source) : undefined;
      page.beforeObserve(() => {
        if (chat) chat.body.textContent = "Do not react.";
        if (captions) captions.sourceRevisions.set(source.id, 2);
      });
      const result = await page.evaluate(
        GOOGLE_MEET_REACTIONS_ADAPTER.buildActionScript({ ...actionParams, source }),
      );
      expect(GOOGLE_MEET_REACTIONS_ADAPTER.parseActionResult(result)).toMatchObject({
        status: "rejected",
      });
      expect(page.buttons.every((node) => node.click.mock.calls.length === 0)).toBe(true);
    },
  );

  it.each(["chat", "caption"] as const)(
    "accepts a finalized current native %s source",
    async (kind) => {
      const source: MeetingParticipationSource = {
        id: "source-1",
        epoch: "epoch-1",
        revision: "1",
        kind,
        text: "Please react with a thumbs up.",
        finalized: true,
        ownEcho: false,
      };
      const page = reactionPage();
      if (kind === "chat") page.setChatSource(source);
      else page.setCaptionSource(source);
      const result = await page.evaluate(
        GOOGLE_MEET_REACTIONS_ADAPTER.buildActionScript({ ...actionParams, source }),
      );
      expect(GOOGLE_MEET_REACTIONS_ADAPTER.parseActionResult(result)).toMatchObject({
        status: "succeeded",
      });
      expect(page.buttons[1].click).toHaveBeenCalledOnce();
    },
  );

  it("does not prepare a palette for an own echo source", async () => {
    const page = reactionPage({ open: false });
    const source: MeetingParticipationSource = {
      id: "source-1",
      epoch: "epoch-1",
      revision: "1",
      kind: "chat",
      text: "Please react.",
      finalized: true,
      ownEcho: true,
    };
    const result = await page.evaluate(
      GOOGLE_MEET_REACTIONS_ADAPTER.buildPreparationScript({ ...actionParams, source }),
    );
    expect(GOOGLE_MEET_REACTIONS_ADAPTER.parsePreparationResult(result)).toMatchObject({
      status: "rejected",
    });
    expect(page.toggle.click).not.toHaveBeenCalled();
  });

  it("also supports the previously observed dialog palette", async () => {
    expect(await reactionPage({ legacyDialog: true }).run()).toMatchObject({ status: "succeeded" });
  });

  it("supports a standalone toolbar without treating a nested toolbar as a second palette", async () => {
    expect(await reactionPage({ standaloneToolbar: true }).run()).toMatchObject({
      status: "succeeded",
    });
  });

  it.each(EMOJIS)("sends %s once and requires a fresh native receipt", async (emoji) => {
    const page = reactionPage({ open: false });
    const result = await page.run(emoji);
    expect(result).toMatchObject({
      status: "succeeded",
      observed: { emoji, confirmation: "native_reaction_announcement", supportedReactions: EMOJIS },
    });
    expect(page.toggle.click).toHaveBeenCalledOnce();
    expect(
      page.buttons.find((node) => node.getAttribute("data-emoji") === emoji)?.click,
    ).toHaveBeenCalledOnce();
    expect(page.buttons.reduce((sum, node) => sum + node.click.mock.calls.length, 0)).toBe(1);
    expect(page.microphone.click).not.toHaveBeenCalled();
    expect(page.hand.click).not.toHaveBeenCalled();
    expect(page.leave.click).not.toHaveBeenCalled();
    expect(page.disconnect).toHaveBeenCalledOnce();
  });

  it("reports only enabled native choices and rejects an unavailable emoji without sending", async () => {
    const page = reactionPage({ available: ["👍", "🎉", "👏", "😮", "🦄"] });
    page.buttons[0].disabled = true;
    page.buttons[1].attributes["aria-disabled"] = "true";
    page.buttons[2].hidden = true;
    expect(await page.run("👍")).toMatchObject({
      status: "rejected",
      correctable: true,
      observed: { supportedReactions: ["😮"] },
    });
    expect(page.buttons.every((node) => node.click.mock.calls.length === 0)).toBe(true);
  });

  it.each(["missing", "disabled", "ambiguous"])(
    "does not guess when the palette is %s",
    async (state) => {
      const page = reactionPage({ open: false });
      if (state === "missing") page.toggle.isConnected = false;
      if (state === "disabled") page.toggle.disabled = true;
      if (state === "ambiguous") {
        page.picker.hidden = false;
        page.root.append(new Element("div", { role: "dialog", "aria-label": "Send a reaction" }));
      }
      expect(await page.run()).toMatchObject({ status: "unsupported" });
      expect(page.toggle.click).not.toHaveBeenCalled();
      expect(page.buttons.every((node) => node.click.mock.calls.length === 0)).toBe(true);
    },
  );

  it("does not choose between duplicate emoji controls", async () => {
    const page = reactionPage({ available: ["👍", "👍"] });
    expect(await page.run()).toMatchObject({ status: "rejected" });
    expect(page.buttons.every((node) => node.click.mock.calls.length === 0)).toBe(true);
  });

  it("wakes an idle toolbar before rediscovering the native reaction toggle", async () => {
    const page = reactionPage({ open: false });
    page.toggle.hidden = true;
    page.root.dispatchEvent.mockImplementation((event) => {
      if (event.type === "mousemove") page.toggle.hidden = false;
      return true;
    });
    expect(await page.run()).toMatchObject({ status: "succeeded" });
    expect(page.root.dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "pointermove",
      "mousemove",
    ]);
    expect(page.toggle.click).toHaveBeenCalledOnce();
    expect(page.buttons[1].click).toHaveBeenCalledOnce();
    expect(page.microphone.click).not.toHaveBeenCalled();
    expect(page.hand.click).not.toHaveBeenCalled();
  });

  it("rechecks ownership before each toolbar wake event", async () => {
    const page = reactionPage({ open: false });
    page.toggle.hidden = true;
    page.root.dispatchEvent.mockImplementation(() => {
      page.window.__openclawMeetAudioSession = "replacement";
      return true;
    });
    expect(await page.run()).toMatchObject({ status: "rejected" });
    expect(page.root.dispatchEvent).toHaveBeenCalledOnce();
    expect(page.toggle.click).not.toHaveBeenCalled();
    expect(page.buttons.every((node) => node.click.mock.calls.length === 0)).toBe(true);
  });

  it.each(["owner", "room", "left"])(
    "rejects stale %s before opening the palette",
    async (change) => {
      const page = reactionPage({ open: false });
      if (change === "owner") page.window.__openclawMeetAudioSession = "replacement";
      if (change === "room") page.location.href = "https://meet.google.com/xyz-abcd-efg";
      if (change === "left") page.leave.isConnected = false;
      expect(await page.run()).toMatchObject({ status: "rejected" });
      expect(page.toggle.click).not.toHaveBeenCalled();
      expect(page.buttons.every((node) => node.click.mock.calls.length === 0)).toBe(true);
    },
  );

  it("rechecks session ownership after waiting for the palette", async () => {
    const page = reactionPage({ open: false });
    page.toggle.click.mockImplementation(() => {});
    page.beforeWait(() => {
      page.picker.hidden = false;
      page.window.__openclawMeetAudioSession = "replacement";
    });
    expect(await page.run()).toMatchObject({ status: "rejected" });
    expect(page.toggle.click).toHaveBeenCalledOnce();
    expect(page.buttons.every((node) => node.click.mock.calls.length === 0)).toBe(true);
  });

  it("rechecks page ownership immediately before clicking the emoji", async () => {
    const page = reactionPage();
    page.beforeObserve(() => {
      page.location.href = "https://meet.google.com/xyz-abcd-efg";
    });
    expect(await page.run()).toMatchObject({ status: "rejected" });
    expect(page.buttons.every((node) => node.click.mock.calls.length === 0)).toBe(true);
    expect(page.disconnect).toHaveBeenCalledOnce();
  });

  it("reports uncertainty when the session changes after a click, without retrying", async () => {
    const page = reactionPage();
    page.beforeWait(() => {
      page.window.__openclawMeetAudioSession = "replacement";
    });
    expect(await page.run()).toMatchObject({ status: "uncertain" });
    expect(page.buttons[1].click).toHaveBeenCalledOnce();
  });

  it.each([
    "absent",
    "preexisting",
    "reparented",
    "other participant",
    "other emoji",
    "before click",
  ])("keeps a click uncertain for a %s announcement", async (receipt) => {
    const page = reactionPage({ receipt: false });
    const old = page.announce("You reacted with 👍.");
    if (receipt === "reparented")
      page.beforeWait(() => page.notify({ target: page.root, addedNodes: [old] }));
    if (receipt === "other participant")
      page.beforeWait(() => {
        page.announce("Alex reacted with 👍.");
      });
    if (receipt === "other emoji")
      page.beforeWait(() => {
        page.announce("You reacted with 👏.");
      });
    if (receipt === "before click")
      page.beforeObserve(() => {
        page.announce("You reacted with 👍.");
      });
    if (receipt === "absent") old.isConnected = false;
    expect(await page.run()).toMatchObject({ status: "uncertain" });
    expect(page.buttons[1].click).toHaveBeenCalledOnce();
  });

  it("accepts a new announcement mutation reusing an existing live region", async () => {
    const page = reactionPage({ receipt: false });
    const region = page.announce("You reacted with 👍.");
    page.buttons[1].click.mockImplementation(() => {
      page.announce("You reacted with 👍.", region);
    });
    expect(await page.run()).toMatchObject({ status: "succeeded" });
  });

  it("does not resend a click that throws after dispatch", async () => {
    const page = reactionPage();
    page.buttons[1].click.mockImplementation(() => {
      throw new Error("lost callback");
    });
    expect(await page.run()).toMatchObject({ status: "uncertain" });
    expect(page.buttons[1].click).toHaveBeenCalledOnce();
    expect(page.disconnect).toHaveBeenCalledOnce();
  });

  it.each(["uncertain", "unsupported", "failed"])(
    "never grants a correction for %s output",
    (status) => {
      expect(
        GOOGLE_MEET_REACTIONS_ADAPTER.parseActionResult({
          result: { status, correctable: true, observed: { supportedReactions: ["👍"] } },
        }),
      ).not.toHaveProperty("correctable");
    },
  );

  it("rejects selector-shaped and extra caller arguments before browser execution", () => {
    expect(
      GOOGLE_MEET_REACTIONS_ADAPTER.validateAction({ type: "reaction.send", emoji: "👍" }),
    ).toBeUndefined();
    for (const action of [
      { type: "reaction.send" },
      { type: "reaction.send", emoji: 1 },
      { type: "reaction.send", emoji: "" },
      { type: "reaction.send", emoji: "button[data-emoji]" },
      { type: "reaction.send", emoji: "👍", selector: "button" },
      { type: "hand.raise", emoji: "👍" },
    ])
      expect(GOOGLE_MEET_REACTIONS_ADAPTER.validateAction(action)).toBeTypeOf("string");
  });

  it.each([
    null,
    {},
    { result: "bad JSON" },
    { result: '{"status":"succeeded"}' },
    {
      result: { status: "succeeded", observed: { supportedReactions: ["👍"], emoji: "👍" } },
    },
    {
      ok: false,
      result: {
        status: "succeeded",
        observed: {
          supportedReactions: ["👍"],
          emoji: "👍",
          confirmation: "native_reaction_announcement",
        },
      },
    },
  ])("does not treat malformed browser output as success: %j", (result) => {
    expect(GOOGLE_MEET_REACTIONS_ADAPTER.parseActionResult(result)).toMatchObject({
      status: "uncertain",
    });
  });
});
import type { MeetingParticipationSource } from "openclaw/plugin-sdk/meeting-runtime";
