import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { begin, finish, postBaselineIdentity, installObserver, restoreObserver } from "./pr148066-capture.mjs";

installObserver();
let observedTask: string | undefined;
afterAll(() => {
  try {
    if (!observedTask) return;
    begin("instrumented-after-baseline", observedTask);
    try { finish(probeScheduledTaskState(observedTask)); } finally { postBaselineIdentity(); }
  } finally { restoreObserver(); }
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
