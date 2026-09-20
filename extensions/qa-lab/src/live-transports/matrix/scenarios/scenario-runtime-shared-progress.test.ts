import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import { runMatrixSharedProgressScenario } from "./scenario-runtime-shared-progress.js";

const mocks = vi.hoisted(() => ({
  now: 0,
  waitForEvent: vi.fn(),
  writeFile: vi.fn<(file: string, content: string) => Promise<void>>(),
}));
vi.mock("node:fs/promises", () => ({ default: { writeFile: mocks.writeFile } }));
vi.mock("node:timers/promises", () => ({
  setTimeout: async (delay: number) => {
    mocks.now += delay;
  },
}));
vi.mock("../../shared/shared-progress-fixture.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/shared-progress-fixture.js")>()),
  prepareSharedProgressFixtureConfig: async () => ({
    run: "SP-observation-order",
    endpoint: new URL("http://127.0.0.1:9"),
    patch: {},
  }),
  sharedProgressWorkersAreHolding: async () => true,
}));
vi.mock("./scenario-runtime-shared.js", () => ({
  primeMatrixQaDriverScenarioClient: async () => ({
    startSince: "start",
    client: {
      sendTextMessage: async () => "driver-event",
      waitForOptionalRoomEvent: mocks.waitForEvent,
    },
  }),
  advanceMatrixQaActorCursor: () => {},
}));

const run = "SP-observation-order";
const plan =
  "Run the parent command\nWait for Maple and Cedar commands\nSummarize the delivered results";
const context = () =>
  createMatrixQaE2eeTestContext({
    sutAccountId: "qa",
    gatewayCall: async () => ({ config: {} }),
    patchGatewayConfig: async () => {},
    restartGateway: async () => {},
    restartGatewayAfterStateMutation: async () => {},
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.now = 0;
  mocks.writeFile.mockResolvedValue(undefined);
  vi.spyOn(Date, "now").mockImplementation(() => mocks.now);
});
afterEach(() => vi.restoreAllMocks());

function driveCancellation(includeParentFinal: boolean) {
  const rows: { at: number; event: MatrixQaObservedEvent }[] = [];
  function add(at: number, id: string, body: string, replacesEventId?: string) {
    rows.push({
      at,
      event: {
        kind: "message",
        roomId: context().roomId,
        sender: context().sutUserId,
        type: "m.room.message",
        eventId: id,
        body,
        replacesEventId,
      },
    });
  }
  add(1000, "card", `${run}\n${plan}`);
  add(2000, "waiting", `SHARED_PROGRESS_WAIT run=${run}\n${plan}`, "card");
  add(
    3000,
    "holding",
    `${run}\n${plan}\nMaple public command activity\nMaple: synthetic completion hold\nCedar: synthetic completion hold`,
    "card",
  );
  add(58000, "ack", `SHARED_PROGRESS_CANCELLED run=${run}`);
  add(73000, "terminal", `${run}\n${plan}\nMaple (cancelled)\nCedar (cancelled)`, "card");
  if (includeParentFinal) {
    add(82000, "parent-final", `SHARED_PROGRESS_INTERRUPTED run=${run}`);
  }
  // A late edit must remain in evidence, not disappear behind the earlier acknowledgement cutoff.
  add(130000, "late-edit", `${run}\n${plan}\nUnexpected late activity`, "card");
  mocks.waitForEvent.mockImplementation(async () => {
    mocks.now += 1000;
    const next = rows[0];
    if (next && next.at <= mocks.now) {
      rows.shift();
      return { matched: true, event: next.event, since: next.event.eventId };
    }
    return { matched: false, since: "idle" };
  });
}

it("records a full minute after both worker settlement and the resumed parent final", async () => {
  driveCancellation(true);
  await runMatrixSharedProgressScenario(context(), "cancel");
  expect(mocks.now).toBeGreaterThanOrEqual(142000);
  expect(mocks.now).toBeLessThan(240000);
  const evidence = JSON.parse(mocks.writeFile.mock.calls[0]![1]);
  expect(evidence.revisions).toContainEqual(
    expect.objectContaining({
      text: expect.stringContaining("Unexpected late activity"),
      elapsedMs: 130000,
      messageId: evidence.cardId,
    }),
  );
});

it("does not mistake cancellation acknowledgement for the resumed parent final", async () => {
  driveCancellation(false);
  await expect(runMatrixSharedProgressScenario(context(), "cancel")).rejects.toThrow(
    "separate_parent_final_observed",
  );
  expect(mocks.now).toBe(240000);
});
