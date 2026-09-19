import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Synchronize the short diagnostic deadline with real child output, not cold startup. */
export async function prepareDoctorOutputDeadlineFixture(
  stubs: Map<string, string>,
  sourceUrl: (relative: string) => string,
  root: string,
  progress: boolean,
): Promise<void> {
  const controlPath = path.join(root, "doctor-deadline-control.mjs");
  const timingPath = path.join(root, "doctor-deadline.json");
  const marker = progress ? "PROGRESS fixture-validation" : "STEP active fixture-validation";
  await fs.writeFile(
    controlPath,
    `
import fs from 'node:fs';
let start;
let armedAtMs;
let observed = '';
export function afterReady(callback) {
  if (start) throw new Error('Doctor deadline was registered twice');
  start = callback;
  if (armedAtMs !== undefined) start();
}
export function observe(chunk, stream) {
  if (stream !== 'stderr' || armedAtMs !== undefined) return;
  observed += chunk.toString('utf8');
  if (!observed.includes(${JSON.stringify(marker)})) return;
  armedAtMs = Date.now();
  fs.writeFileSync(${JSON.stringify(timingPath)}, JSON.stringify({ armedAtMs, marker: ${JSON.stringify(marker)} }));
  start?.();
}
`,
  );
  const control = pathToFileURL(controlPath).href;
  const deadlineUrl = sourceUrl("./update-cli/update-operation-deadline.ts");
  stubs.set(
    deadlineUrl,
    `
import { createUpdateOperationDeadline as realDeadline } from ${JSON.stringify(`${deadlineUrl}?fixture-original`)};
import { afterReady } from ${JSON.stringify(control)};
export function createUpdateOperationDeadline(onExpired) {
  const deadline = realDeadline(onExpired);
  const start = deadline.start;
  deadline.start = (error, timeoutMs) => {
    if (error.message === 'Update finalization timed out in doctor after 1000ms') {
      afterReady(() => start(error, timeoutMs));
    } else start(error, timeoutMs);
  };
  return deadline;
}
`,
  );
  const outputUrl = sourceUrl("./update-cli/update-finalization-output.ts");
  stubs.set(
    outputUrl,
    `
export * from ${JSON.stringify(`${outputUrl}?fixture-original`)};
import { captureUpdateFinalizationDoctorOutput as realCapture } from ${JSON.stringify(`${outputUrl}?fixture-original`)};
import { observe } from ${JSON.stringify(control)};
export function captureUpdateFinalizationDoctorOutput(phase) {
  const capture = realCapture(phase);
  if (!capture) throw new Error('Doctor output has no real finalization owner');
  return (chunk, stream) => { capture(chunk, stream); observe(chunk, stream); };
}
`,
  );
  const doctorUrl = sourceUrl("./update-cli/update-command-fresh-doctor.ts");
  stubs.set(
    doctorUrl,
    `
export * from ${JSON.stringify(`${doctorUrl}?fixture-original`)};
import { runUpdateFinalizationDoctorInFreshProcess as realDoctor } from ${JSON.stringify(`${doctorUrl}?fixture-original`)};
// The real finalization deadline owns this deliberate hang. Do not race it with
// the command runner's separate startup-inclusive timeout; the outer test keeps
// its normal deadlock guard if Doctor never reaches the required marker.
export const runUpdateFinalizationDoctorInFreshProcess = params => realDoctor({ ...params, timeoutMs: undefined });
`,
  );
}
