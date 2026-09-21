import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { begin, finish, postBaselineIdentity } from "./pr148066-capture.mjs";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { observe } = await import("./pr148066-capture.mjs");
  return { ...actual, spawnSync: (...args: Parameters<typeof actual.spawnSync>) => observe(actual.spawnSync, ...args) };
});
let observedTask: string | undefined;
afterAll(() => {
  if (!observedTask) return;
  begin("instrumented-after-baseline", observedTask);
  try { finish(probeScheduledTaskState(observedTask)); } finally { postBaselineIdentity(); }
}, 30_000);
import { probeScheduledTaskState } from "./schtasks-state-probe.js";

it.skipIf(process.platform !== "win32")(
  "reads real Windows PowerShell task presence without an unknown result",
  () => {
    const taskName = `OpenClaw probe test ${randomUUID()}`;
    observedTask = taskName;
    begin("baseline-first-use", taskName);
    const missing = probeScheduledTaskState(taskName);
    finish(missing);
    console.log("Unregistered task probe:", missing);
    expect(missing).toEqual({ status: "missing" });

    // Registration/found/delete are OUT OF SCOPE and physically absent.

  },
  30_000,
);
