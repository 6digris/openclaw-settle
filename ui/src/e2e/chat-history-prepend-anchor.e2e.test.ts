import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
type PrependTraceEntry = {
  sequence: number;
  at: number;
  phase: string;
  state: Record<string, unknown>;
};
type PrependTrace = {
  baselineY: number;
  samples: PrependTraceEntry[];
  events: PrependTraceEntry[];
  sampleCount: number;
  eventCount: number;
  firstBad: PrependTraceEntry | null;
  issue: string | null;
  restoreErrors: string[];
  sample(bubble: HTMLElement | undefined, top: number | null): void;
  stop(): void;
};
type PrependDiagnostic = {
  diagnostic:
    | (Omit<PrependTrace, "sample" | "stop"> & {
        positionCount: number;
        overwrittenSamples: number;
        overwrittenEvents: number;
      })
    | null;
  diagnosticUnavailable: string | null;
};
type AnchorFrames = {
  frame: number;
  positions: Array<number | null>;
  readerDelta: number;
  trace?: PrependTrace;
  diagnosticUnavailable?: string;
};
type AnchorWindow = typeof window & { prependFrames: AnchorFrames };

type PrependProbeOriginal = {
  label: string;
  target: Record<string, unknown>;
  name: string;
  descriptor: PropertyDescriptor | undefined;
  value: unknown;
};
type PrependProbeWindow = AnchorWindow & {
  prependDiagnosticProbe?: {
    pane: Element;
    scroller: Element;
    controller: Record<string, unknown>;
    owner: Record<string, unknown>;
    originals: PrependProbeOriginal[];
  };
};

const prependProbeSentinel = "HISTORY_PREPEND_DIAGNOSTIC_PROBE_82e9e59";
const prependProbeHookLabels = [
  "syncRows",
  "host.update",
  "measureRows",
  "capture",
  "anchor.update",
  "moveWithReader",
  "clear",
  "scrollToOffset",
];

// Disposable proof only: inspect the same listener registrations as the picker
// contract test. The observer and the ordinary failure writer stay unchanged.
async function prependProbeListeners(protocol: CDPSession) {
  const objectGroup = "history-prepend-diagnostic-probe";
  try {
    const { result } = await protocol.send("Runtime.evaluate", {
      expression: 'document.querySelector(".chat-pane-cache__pane--active .chat-thread")',
      objectGroup,
    });
    if (!result.objectId) {
      throw new Error("Prepend probe scroller is unavailable");
    }
    const { listeners } = await protocol.send("DOMDebugger.getEventListeners", {
      objectId: result.objectId,
    });
    return listeners
      .filter((listener) =>
        ["touchstart", "touchend", "touchcancel", "scroll", "scrollend"].includes(listener.type),
      )
      .map((listener) =>
        JSON.stringify({
          type: listener.type,
          capture: listener.useCapture,
          passive: listener.passive,
          once: listener.once,
          script: listener.scriptId,
          line: listener.lineNumber,
          column: listener.columnNumber,
        }),
      )
      .toSorted();
  } finally {
    await protocol.send("Runtime.releaseObjectGroup", { objectGroup });
  }
}

function prependProbeAddedListeners(before: string[], after: string[]) {
  const added = [...after];
  for (const listener of before) {
    const index = added.indexOf(listener);
    expect(
      index,
      "the same scroller must retain its pre-existing listeners",
    ).toBeGreaterThanOrEqual(0);
    added.splice(index, 1);
  }
  return added;
}

async function startPrependDiagnosticProbe(page: Page, protocol: CDPSession) {
  const baselineListeners = await prependProbeListeners(protocol);
  await page.evaluate(() => {
    // This closure runs inside Chromium and cannot import the Node-side guard.
    const record = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Prepend probe owner is unavailable");
      }
      return value as Record<string, unknown>;
    };
    const pane = document.querySelector(".chat-pane-cache__pane--active");
    const scroller = pane?.querySelector(".chat-thread");
    if (!(pane instanceof HTMLElement) || !(scroller instanceof HTMLElement)) {
      throw new Error("Prepend probe pane or scroller is unavailable");
    }
    const controller = record(Reflect.get(pane, "transcript"));
    const owner = record(controller.sessionVirtualizer);
    const anchor = record(owner.prependAnchor);
    const adapter = record(owner.virtualizerController);
    if (typeof adapter.getVirtualizer !== "function") {
      throw new Error("Prepend probe virtualizer getter is unavailable");
    }
    const virtualizer = record(Reflect.apply(adapter.getVirtualizer, adapter, []));
    const targets: Array<[Record<string, unknown>, string, string]> = [
      [owner, "syncRows", "syncRows"],
      [owner, "update", "host.update"],
      [owner, "measureConnectedRows", "measureRows"],
      [anchor, "capture", "capture"],
      [anchor, "update", "anchor.update"],
      [anchor, "moveWithReader", "moveWithReader"],
      [anchor, "clear", "clear"],
      [virtualizer, "scrollToOffset", "scrollToOffset"],
    ];
    const originals = targets.map(([target, name, label]) => {
      const value = target[name];
      if (typeof value !== "function") {
        throw new Error("Prepend probe method is unavailable: " + label);
      }
      return {
        target,
        name,
        label,
        value,
        descriptor: Object.getOwnPropertyDescriptor(target, name),
      };
    });
    (window as PrependProbeWindow).prependDiagnosticProbe = {
      pane,
      scroller,
      controller,
      owner,
      originals,
    };
  });
  let armedState:
    | {
        installed: string[];
        diagnosticUnavailable: string | null;
        issue: string | null;
        armed: boolean;
        sampleCount: number;
      }
    | undefined;
  let armedListeners: string[] | undefined;
  let fixtureListeners: string[] | undefined;
  return {
    async recordArmed() {
      armedState = await page.evaluate(() => {
        const state = (window as PrependProbeWindow).prependDiagnosticProbe;
        if (!state) {
          throw new Error("Prepend probe original descriptors are unavailable");
        }
        const frames = (window as AnchorWindow).prependFrames;
        return {
          installed: state.originals
            .filter(({ target, name, value }) => {
              const descriptor = Object.getOwnPropertyDescriptor(target, name);
              return typeof descriptor?.value === "function" && descriptor.value !== value;
            })
            .map(({ label }) => label),
          diagnosticUnavailable: frames.diagnosticUnavailable ?? null,
          issue: frames.trace?.issue ?? null,
          armed: frames.trace?.events.some((entry) => entry.phase === "armed") ?? false,
          sampleCount: frames.trace?.sampleCount ?? 0,
        };
      });
      armedListeners = await prependProbeListeners(protocol);
    },
    async recordFixtureListener() {
      fixtureListeners = await prependProbeListeners(protocol);
    },
    async verify() {
      expect(armedState).toMatchObject({
        installed: prependProbeHookLabels,
        diagnosticUnavailable: null,
        issue: null,
        armed: true,
      });
      expect(armedState?.sampleCount).toBeGreaterThan(0);
      expect(armedListeners).toBeDefined();
      expect(fixtureListeners).toBeDefined();
      const observerListeners = prependProbeAddedListeners(baselineListeners, armedListeners!);
      expect(observerListeners.map((entry) => JSON.parse(entry).type).toSorted()).toEqual([
        "scroll",
        "scrollend",
        "touchcancel",
        "touchend",
        "touchstart",
      ]);
      const fixtureOnly = prependProbeAddedListeners(armedListeners!, fixtureListeners!);
      expect(fixtureOnly).toHaveLength(1);
      expect(JSON.parse(fixtureOnly[0]!)).toMatchObject({ type: "scrollend", capture: true });
      const restored = await page.evaluate(async () => {
        const state = (window as PrependProbeWindow).prependDiagnosticProbe;
        if (!state) {
          throw new Error("Prepend probe original descriptors are unavailable");
        }
        const frames = (window as AnchorWindow).prependFrames;
        const positionCount = frames.positions.length;
        const frame = frames.frame;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const methods = state.originals.map(({ target, name, label, value, descriptor }) => {
          const current = Object.getOwnPropertyDescriptor(target, name);
          return {
            label,
            restored:
              target[name] === value &&
              (descriptor === undefined
                ? current === undefined
                : current !== undefined &&
                  Reflect.ownKeys(current).length === Reflect.ownKeys(descriptor).length &&
                  Reflect.ownKeys(descriptor).every(
                    (key) => Reflect.get(current, key) === Reflect.get(descriptor, key),
                  )),
          };
        });
        const result = {
          sameOwner:
            document.querySelector(".chat-pane-cache__pane--active") === state.pane &&
            state.pane.querySelector(".chat-thread") === state.scroller &&
            Reflect.get(state.pane, "transcript") === state.controller &&
            state.controller.sessionVirtualizer === state.owner,
          methods,
          rafStopped: frames.frame === frame && frames.positions.length === positionCount,
          positionCount,
          restoreErrors: frames.trace?.restoreErrors,
        };
        delete (window as PrependProbeWindow).prependDiagnosticProbe;
        return result;
      });
      expect(restored.sameOwner).toBe(true);
      expect(restored.methods).toEqual(
        prependProbeHookLabels.map((label) => ({ label, restored: true })),
      );
      expect(restored.rafStopped).toBe(true);
      expect(restored.restoreErrors).toEqual([]);
      const finalListeners = await prependProbeListeners(protocol);
      expect(finalListeners).toEqual([...baselineListeners, ...fixtureOnly].toSorted());
      return {
        armed: armedState,
        restoration: restored,
        baselineListeners,
        observerListeners,
        fixtureOnly,
        finalListeners,
      };
    },
  };
}

suite.define(() => {
  it.each([
    { sharedGroup: false, manual: false, onlyGroup: false, more: false },
    { sharedGroup: true, manual: false, onlyGroup: false, more: false },
    { sharedGroup: false, manual: true, onlyGroup: false, more: false },
    { sharedGroup: true, manual: true, onlyGroup: false, more: false },
    { sharedGroup: true, manual: false, onlyGroup: true, more: false },
    { sharedGroup: true, manual: false, onlyGroup: true, more: true },
    { sharedGroup: true, manual: false, onlyGroup: true, more: false, persisted: false },
    { sharedGroup: true, manual: false, onlyGroup: false, more: true, activeTouch: true },
    {
      sharedGroup: true,
      manual: false,
      onlyGroup: false,
      more: true,
      activeTouch: true,
      momentum: true,
    },
  ])(
    "anchors history prepend (shared=$sharedGroup, manual=$manual, onlyGroup=$onlyGroup, more=$more, persisted=$persisted, touch=$activeTouch, momentum=$momentum)",
    async ({
      sharedGroup,
      manual,
      onlyGroup,
      more,
      persisted = true,
      activeTouch = false,
      momentum = false,
    }) => {
      const artifactDir = createControlUiE2eArtifactDir("chat-history-prepend-anchor");
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        hasTouch: activeTouch,
        ...(activeTouch
          ? {
              userAgent:
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
            }
          : {}),
        viewport: { height: 900, width: 1280 },
        recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
      });
      const page = await context.newPage();
      const message = (seq: number) => ({
        __openclaw: { ...(persisted ? { id: `prepend-${seq}` } : {}), seq },
        role:
          sharedGroup && seq >= 995 && seq <= 1005 ? "assistant" : seq % 2 ? "user" : "assistant",
        content: [
          {
            type: "text",
            text: `Transcript entry ${seq}. ${"History detail for the reader. ".repeat(8)}`,
          },
        ],
        timestamp: 1_800_000_000_000 + seq,
      });
      const recent = Array.from({ length: 800 }, (_, index) => message(index + 1001));
      const older = Array.from({ length: onlyGroup ? 6 : 1000 }, (_, index) =>
        message(index + (onlyGroup ? 995 : 1)),
      );
      const loadedCount = recent.length + older.length;
      const totalMessages = loadedCount + (more ? 10 : 0);
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        sessions: [{ key: "agent:main:main", sessionId: "prepend-session" }],
        methodResponses: {
          "chat.startup": {
            messages: recent,
            hasMore: true,
            nextOffset: 800,
            totalMessages,
            sessionId: "prepend-session",
          },
          "chat.history": {
            messages: older,
            hasMore: more,
            nextOffset: loadedCount,
            totalMessages,
            sessionId: "prepend-session",
          },
        },
      });
      let capturedDiagnostic: PrependDiagnostic = {
        diagnostic: null,
        diagnosticUnavailable: "original sampler did not complete",
      };
      let diagnosticProtocol: CDPSession | undefined;
      let diagnosticProbe: Awaited<ReturnType<typeof startPrependDiagnosticProbe>> | undefined;
      let diagnosticProbeSentinelIssued = false;
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const pane = page.locator(".chat-pane-cache__pane--active");
        const thread = pane.locator(".chat-thread");
        await thread.getByText(/^Transcript entry 1800\./).waitFor();
        await waitForChatScrollIdle(page);
        await gateway.deferNext("chat.history");
        await thread.hover();
        await page.mouse.wheel(0, -1_000_000);
        await waitForRequests(gateway, "chat.history", 1);
        if (manual) {
          // A failed automatic load exposes the explicit retry control without
          // another upward gesture consuming history before the reader clicks.
          await gateway.rejectDeferred("chat.history", {
            message: "History temporarily unavailable",
          });
          const showEarlier = thread.getByRole("button", { name: "Show earlier", exact: true });
          await expect.poll(() => showEarlier.isEnabled()).toBe(true);
          await gateway.deferNext("chat.history");
          await showEarlier.click();
          await waitForRequests(gateway, "chat.history", 2);
        }
        await waitForChatScrollIdle(page);
        const anchor = thread.locator(".chat-bubble").filter({ hasText: "Transcript entry 1001." });
        await anchor.waitFor();
        const before = await anchor.boundingBox();
        expect(before).not.toBeNull();
        await page.screenshot({ path: path.join(artifactDir, "before-prepend.png") });
        if (momentum) {
          diagnosticProtocol = await context.newCDPSession(page);
          diagnosticProbe = await startPrependDiagnosticProbe(page, diagnosticProtocol);
        }
        await page.evaluate(
          ({ messageKey, momentum: observeMomentum, baselineY }) => {
            const frames: AnchorFrames = { frame: 0, positions: [], readerDelta: 0 };
            (window as AnchorWindow).prependFrames = frames;
            if (observeMomentum) {
              try {
                // Diagnostic only: observe the real owner without changing its scheduling.
                // These TS-private fields must exist in the bundled page before any hook is installed.
                const object = (value: unknown, label: string): Record<string, unknown> => {
                  if (!value || typeof value !== "object" || Array.isArray(value)) {
                    throw new Error("Missing prepend diagnostic owner: " + label);
                  }
                  return value as Record<string, unknown>;
                };
                const diagnosticPane = document.querySelector(".chat-pane-cache__pane--active");
                const controller = object(object(diagnosticPane, "pane").transcript, "controller");
                const owner = object(controller.sessionVirtualizer, "sessionVirtualizer");
                const prependAnchor = object(owner.prependAnchor, "prependAnchor");
                const offset = object(owner.offsetState, "offsetState");
                const adapter = object(owner.virtualizerController, "virtualizerController");
                if (typeof adapter.getVirtualizer !== "function") {
                  throw new Error("Missing prepend diagnostic virtualizer getter");
                }
                const virtualizer = object(
                  Reflect.apply(adapter.getVirtualizer, adapter, []),
                  "virtualizer",
                );
                const scroller = diagnosticPane?.querySelector(".chat-thread");
                if (!(scroller instanceof HTMLElement)) {
                  throw new Error("Missing prepend diagnostic scroller");
                }
                if (typeof messageKey !== "string" || !messageKey) {
                  throw new Error("Missing prepend diagnostic message key");
                }
                let sequence = 0;
                let stopped = false;
                const undo: Array<() => void> = [];
                const short = (value: unknown): string | null => {
                  if (value === null || value === undefined) {
                    return null;
                  }
                  if (
                    typeof value !== "string" &&
                    typeof value !== "number" &&
                    typeof value !== "bigint"
                  ) {
                    throw new Error("Unsupported prepend diagnostic key");
                  }
                  const text = String(value);
                  if (text.length > 128) {
                    throw new Error("Prepend diagnostic key exceeds 128 characters");
                  }
                  return text;
                };
                const readState = (): Record<string, unknown> => {
                  if (
                    controller.sessionVirtualizer !== owner ||
                    owner.scrollElement !== scroller ||
                    virtualizer.scrollElement !== scroller
                  ) {
                    throw new Error("Prepend diagnostic owner changed");
                  }
                  const options = object(virtualizer.options, "options");
                  const flags = {
                    touching: offset.touching,
                    touchScrolling: offset.touchScrolling,
                    isScrolling: virtualizer.isScrolling,
                    iosTouching: virtualizer["_iosTouching"],
                    iosJustTouchEnded: virtualizer["_iosJustTouchEnded"],
                  };
                  const numbers = {
                    adjustments: virtualizer.scrollAdjustments,
                    iosDeferred: virtualizer["_iosDeferredAdjustment"],
                    count: options.count,
                    margin: options.scrollMargin,
                  };
                  if (
                    Object.values(flags).some((value) => typeof value !== "boolean") ||
                    Object.values(numbers).some(
                      (value) => typeof value !== "number" || !Number.isFinite(value),
                    ) ||
                    (virtualizer.scrollOffset !== null &&
                      (typeof virtualizer.scrollOffset !== "number" ||
                        !Number.isFinite(virtualizer.scrollOffset))) ||
                    !Array.isArray(owner.rowKeys) ||
                    !(owner.committedMessageRowsByKey instanceof Map) ||
                    !(virtualizer.itemSizeCache instanceof Map)
                  ) {
                    throw new Error("Unsupported prepend diagnostic state");
                  }
                  for (const name of ["pendingScrollOffset", "scrollCommand"]) {
                    if (offset[name] !== null) {
                      object(offset[name], name);
                    }
                  }
                  const pending =
                    prependAnchor.pending === null
                      ? null
                      : object(prependAnchor.pending, "pending anchor");
                  if (
                    pending &&
                    (typeof pending.top !== "number" ||
                      !Number.isFinite(pending.top) ||
                      typeof pending.measured !== "boolean" ||
                      typeof pending.messageKey !== "string" ||
                      (pending.rowKey !== null && typeof pending.rowKey !== "string"))
                  ) {
                    throw new Error("Unsupported prepend diagnostic anchor");
                  }
                  const virtualAnchor = virtualizer.pendingScrollAnchor;
                  if (
                    virtualAnchor !== null &&
                    (!Array.isArray(virtualAnchor) ||
                      virtualAnchor.length !== 4 ||
                      (virtualAnchor[0] !== null &&
                        !["string", "number", "bigint"].includes(typeof virtualAnchor[0])) ||
                      typeof virtualAnchor[1] !== "number" ||
                      !Number.isFinite(virtualAnchor[1]) ||
                      typeof virtualAnchor[3] !== "number" ||
                      !Number.isFinite(virtualAnchor[3]) ||
                      (virtualAnchor[2] !== null && typeof virtualAnchor[2] !== "string"))
                  ) {
                    throw new Error("Unsupported prepend diagnostic virtual anchor");
                  }
                  return {
                    ...flags,
                    ...numbers,
                    virtualOffset: virtualizer.scrollOffset,
                    pendingOffset: offset.pendingScrollOffset !== null,
                    command: offset.scrollCommand !== null,
                    rows: owner.rowKeys.length,
                    committedRow: short(owner.committedMessageRowsByKey.get(messageKey)),
                    pending: pending
                      ? {
                          message: short(pending.messageKey),
                          row: short(pending.rowKey),
                          top: pending.top,
                          measured: pending.measured,
                        }
                      : null,
                    virtualAnchor: Array.isArray(virtualAnchor)
                      ? [
                          short(virtualAnchor[0]),
                          virtualAnchor[1],
                          short(virtualAnchor[2]),
                          virtualAnchor[3],
                        ]
                      : null,
                  };
                };
                const trace: PrependTrace = {
                  baselineY,
                  samples: [],
                  events: [],
                  sampleCount: 0,
                  eventCount: 0,
                  firstBad: null,
                  issue: null,
                  restoreErrors: [],
                  sample(bubble, top) {
                    if (stopped || trace.issue) {
                      return;
                    }
                    try {
                      const state = readState();
                      const row = bubble?.closest<HTMLElement>(".chat-virtual-row");
                      const rect = row?.getBoundingClientRect();
                      const cached = (virtualizer.itemSizeCache as Map<string, number>).get(
                        row?.dataset.virtualRowKey ?? "",
                      );
                      if (cached !== undefined && !Number.isFinite(cached)) {
                        throw new Error("Unsupported prepend diagnostic row size");
                      }
                      const entry = {
                        sequence: sequence++,
                        at: performance.now(),
                        phase: "frame",
                        state: {
                          ...state,
                          frame: frames.positions.length - 1,
                          top,
                          readerDelta: frames.readerDelta,
                          nativeOffset: scroller.scrollTop,
                          scrollHeight: scroller.scrollHeight,
                          clientHeight: scroller.clientHeight,
                          row: short(row?.dataset.virtualRowKey),
                          rowIndex: short(row?.dataset.index),
                          rowTop: rect?.top ?? null,
                          rowHeight: rect?.height ?? null,
                          bubbleInRow:
                            top !== null && rect ? top - frames.readerDelta - rect.top : null,
                          cachedRowSize: cached ?? null,
                          blockTransform: short(
                            row?.closest<HTMLElement>(".chat-virtual-block")?.style.transform,
                          ),
                          sizerHeight: short(
                            row?.closest<HTMLElement>(".chat-virtual-sizer")?.style.height,
                          ),
                        },
                      };
                      trace.samples[trace.sampleCount++ % 256] = entry;
                      if (!trace.firstBad && (top === null || Math.abs(top - baselineY) > 2)) {
                        trace.firstBad = entry;
                      }
                    } catch (error) {
                      trace.issue = String(error).slice(0, 256);
                    }
                  },
                  stop() {
                    if (stopped) {
                      return;
                    }
                    stopped = true;
                    for (const restore of undo.toReversed()) {
                      try {
                        restore();
                      } catch (error) {
                        trace.restoreErrors.push(String(error).slice(0, 256));
                      }
                    }
                  },
                };
                frames.trace = trace;
                const mark = (phase: string, argument?: unknown) => {
                  if (stopped || trace.issue) {
                    return;
                  }
                  try {
                    const entry = {
                      sequence: sequence++,
                      at: performance.now(),
                      phase,
                      state: {
                        ...readState(),
                        argument: typeof argument === "number" ? short(argument) : null,
                      },
                    };
                    trace.events[trace.eventCount++ % 512] = entry;
                  } catch (error) {
                    trace.issue = String(error).slice(0, 256);
                  }
                };
                const hook = (target: Record<string, unknown>, name: string, label: string) => {
                  const descriptor = Object.getOwnPropertyDescriptor(target, name);
                  const original = target[name];
                  if (
                    typeof original !== "function" ||
                    (descriptor && (!descriptor.configurable || !("value" in descriptor))) ||
                    (!descriptor && !Object.isExtensible(target))
                  ) {
                    throw new Error("Unsupported prepend diagnostic method: " + label);
                  }
                  Object.defineProperty(target, name, {
                    ...(descriptor ?? { configurable: true, enumerable: false, writable: true }),
                    value(this: unknown, ...args: unknown[]) {
                      mark(label + ":before", args[0]);
                      let threw = true;
                      try {
                        const result: unknown = Reflect.apply(original, this, args);
                        threw = false;
                        return result;
                      } finally {
                        // Recording must never replace a return value or an original exception.
                        mark(label + (threw ? ":throw" : ":after"), args[0]);
                      }
                    },
                  });
                  undo.push(() => {
                    if (descriptor) {
                      Object.defineProperty(target, name, descriptor);
                    } else if (!Reflect.deleteProperty(target, name)) {
                      throw new Error("Could not restore prepend diagnostic method: " + label);
                    }
                  });
                };
                readState();
                // capture/syncRows run inside the permitted projection callback, not just render entry.
                hook(owner, "syncRows", "syncRows");
                hook(owner, "update", "host.update");
                hook(owner, "measureConnectedRows", "measureRows");
                hook(prependAnchor, "capture", "capture");
                hook(prependAnchor, "update", "anchor.update");
                hook(prependAnchor, "moveWithReader", "moveWithReader");
                hook(prependAnchor, "clear", "clear");
                hook(virtualizer, "scrollToOffset", "scrollToOffset");
                for (const type of [
                  "touchstart",
                  "touchend",
                  "touchcancel",
                  "scroll",
                  "scrollend",
                ]) {
                  // The fixture suppresses scrollend delivery; capture observes dispatch only.
                  const capture = type === "scrollend";
                  const listener = () => mark(type + (capture ? ":dispatch" : ":after-listeners"));
                  scroller.addEventListener(type, listener, { passive: true, capture });
                  undo.push(() => scroller.removeEventListener(type, listener, { capture }));
                }
                mark("armed");
              } catch (error) {
                frames.diagnosticUnavailable = String(error).slice(0, 256);
                frames.trace?.stop();
              }
            }
            const sample = () => {
              const bubble = [
                ...document.querySelectorAll<HTMLElement>(
                  ".chat-pane-cache__pane--active .chat-bubble[data-message-id]",
                ),
              ].find((element) => element.dataset.messageId === messageKey);
              const top = bubble ? bubble.getBoundingClientRect().top + frames.readerDelta : null;
              frames.positions.push(top);
              frames.trace?.sample(bubble, top);
              frames.frame = requestAnimationFrame(sample);
            };
            sample();
          },
          {
            messageKey: await anchor.getAttribute("data-message-id"),
            momentum,
            baselineY: before!.y,
          },
        );
        await diagnosticProbe?.recordArmed();
        const heldOffset = await thread.evaluate((element) => element.scrollTop);
        if (activeTouch) {
          if (momentum) {
            // Chromium emits scrollend itself; suppress delivery to model
            // browsers that only provide the offset observer's idle callback.
            await thread.evaluate((element) =>
              element.addEventListener("scrollend", (event) => event.stopImmediatePropagation(), {
                capture: true,
              }),
            );
            await diagnosticProbe?.recordFixtureListener();
          }
          await thread.dispatchEvent("touchstart");
          if (momentum) {
            await thread.evaluate((element) => {
              (window as AnchorWindow).prependFrames.readerDelta += 20;
              element.scrollTop += 20;
              element.dispatchEvent(new Event("scroll"));
            });
          }
        }
        await gateway.resolveDeferred("chat.history");
        await expect
          .poll(() =>
            pane.evaluate(
              (element) =>
                (element as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages
                  .length,
            ),
          )
          .toBe(loadedCount);
        if (activeTouch) {
          // Let the real projection commit before checking that compensation
          // respects the dependency's active-touch deferral.
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
          expect(
            await thread.evaluate((element) => element.scrollTop),
            "a history prepend must not write the scroll offset during an active touch",
          ).toBe(heldOffset + (momentum ? 20 : 0));
          await thread.dispatchEvent("touchend");
          if (momentum) {
            // Synthetic offset events protect ownership ordering, not native
            // Safari inertia. Natural reader movement is removed from samples.
            await thread.evaluate((element) => {
              (window as AnchorWindow).prependFrames.readerDelta += 20;
              element.scrollTop += 20;
              element.dispatchEvent(new Event("scroll"));
            });
            // Deliberately omit scrollend: the offset observer must release history.
          }
        }
        await waitForChatScrollIdle(page);
        // State can contain the fetched page while the rendered projection is
        // still held. Require its added extent to reach the native viewport.
        await expect
          .poll(() => thread.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(heldOffset + (momentum ? 40 : 0) + 100);
        await page.screenshot({ path: path.join(artifactDir, "after-prepend.png") });
        const { positions: frames, ...diagnostic } = await page.evaluate((captureMomentum) => {
          const probe = (window as AnchorWindow).prependFrames;
          cancelAnimationFrame(probe.frame);
          probe.trace?.stop();
          const snapshot: PrependDiagnostic = {
            diagnostic: null,
            diagnosticUnavailable: captureMomentum
              ? (probe.diagnosticUnavailable ?? "trace unavailable")
              : null,
          };
          if (captureMomentum) {
            try {
              const trace = probe.trace;
              if (trace) {
                snapshot.diagnostic = {
                  baselineY: trace.baselineY,
                  samples: trace.samples.toSorted((a, b) => a.sequence - b.sequence),
                  events: trace.events.toSorted((a, b) => a.sequence - b.sequence),
                  sampleCount: trace.sampleCount,
                  eventCount: trace.eventCount,
                  positionCount: probe.positions.length,
                  overwrittenSamples: Math.max(0, trace.sampleCount - 256),
                  overwrittenEvents: Math.max(0, trace.eventCount - 512),
                  firstBad: trace.firstBad,
                  issue: trace.issue,
                  restoreErrors: trace.restoreErrors,
                };
                snapshot.diagnosticUnavailable = probe.diagnosticUnavailable ?? null;
              }
            } catch (diagnosticError) {
              snapshot.diagnosticUnavailable = String(diagnosticError).slice(0, 256);
            }
          }
          return { positions: probe.positions, ...snapshot };
        }, momentum);
        capturedDiagnostic = diagnostic;
        const after = await anchor.boundingBox();
        console.log(
          JSON.stringify({
            sharedGroup,
            manual,
            onlyGroup,
            more,
            before,
            after,
            frames,
            artifactDir,
          }),
        );
        expect(after, "the message being read must remain rendered").not.toBeNull();
        expect(
          Math.abs(after!.y + (momentum ? 40 : 0) - before!.y),
          "loading older history must not move the message being read",
        ).toBeLessThanOrEqual(2);
        expect(frames.length).toBeGreaterThan(1);
        expect(
          frames.every((top) => top !== null && Math.abs(top - before!.y) <= 2),
          "the message must stay anchored at every animation frame, not just after settling",
        ).toBe(true);
        if (momentum) {
          expect(diagnosticProbe).toBeDefined();
          const proof = await diagnosticProbe!.verify();
          expect(capturedDiagnostic.diagnosticUnavailable).toBeNull();
          expect(capturedDiagnostic.diagnostic).not.toBeNull();
          expect(capturedDiagnostic.diagnostic?.issue).toBeNull();
          expect(capturedDiagnostic.diagnostic?.restoreErrors).toEqual([]);
          expect(capturedDiagnostic.diagnostic?.sampleCount).toBeGreaterThan(1);
          const phases = capturedDiagnostic.diagnostic!.events.map((entry) => entry.phase);
          expect(phases.some((phase) => phase.endsWith(":before"))).toBe(true);
          expect(phases.some((phase) => phase.endsWith(":after"))).toBe(true);
          console.info("[history-prepend-diagnostic-probe] oracles passed", JSON.stringify(proof));
          diagnosticProbeSentinelIssued = true;
          throw new Error(prependProbeSentinel);
        }
      } catch (error) {
        if (momentum) {
          try {
            const { diagnostic, diagnosticUnavailable } = capturedDiagnostic;
            const report = {
              schemaVersion: 1,
              case: { sharedGroup, manual, onlyGroup, more, persisted, activeTouch, momentum },
              failure: String(error).slice(0, 1024),
              diagnostic,
              diagnosticUnavailable,
              omittedForSize: { samples: 0, events: 0 },
            };
            let json = JSON.stringify(report);
            if (diagnostic) {
              while (
                Buffer.byteLength(json, "utf8") + 1 > 256 * 1024 &&
                (diagnostic.samples.length || diagnostic.events.length)
              ) {
                // Keep the latest bounded window and the first bad frame; report every dropped record.
                for (const kind of ["samples", "events"] as const) {
                  report.omittedForSize[kind] += diagnostic[kind].splice(
                    0,
                    Math.ceil(diagnostic[kind].length / 2),
                  ).length;
                }
                json = JSON.stringify(report);
              }
            }
            if (Buffer.byteLength(json, "utf8") + 1 > 256 * 1024) {
              throw new Error("Prepend diagnostic metadata exceeds 256 KiB", { cause: error });
            }
            const failureDir = createControlUiE2eArtifactDir(
              "chat-history-prepend-failure",
              process.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR?.trim() || artifactDir,
            );
            await writeFile(path.join(failureDir, "prepend-trace.json"), json + "\n", "utf8");
          } catch (diagnosticError) {
            console.error("[history-prepend] diagnostic capture failed:", String(diagnosticError));
          }
        }
        throw error;
      } finally {
        try {
          await diagnosticProtocol?.detach();
        } finally {
          await suite.closeBrowserContext(context);
        }
        if (diagnosticProbeSentinelIssued) {
          expect(suite.browser.contexts()).not.toContain(context);
          console.info("[history-prepend-diagnostic-probe] context closed", prependProbeSentinel);
        }
      }
    },
  );
});
