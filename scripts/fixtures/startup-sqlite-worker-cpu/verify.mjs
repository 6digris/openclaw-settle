import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Called after the existing lifecycle owner has joined. Raw profile bytes stay unchanged.
export async function verifyWorkerCapture(directory) {
  const eventsBytes = await fs.readFile(path.join(directory, "events.jsonl"));
  const events = eventsBytes
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const header = events[0];
  assert.equal(header.event, "attachment");
  const finish = events.at(-1);
  assert.equal(finish.event, "observer-exit");
  assert.equal(finish.code, 0);
  assert.equal(finish.claimed, true);
  assert.equal(finish.dropped, 0);
  assert.deepEqual(finish.errors, []);
  assert.ok(events.every((event) => Number.isFinite(event.monotonicUs)));
  assert.ok(
    !events.some((event) =>
      ["target-refused", "construct-throw", "send-throw", "worker-error"].includes(event.event),
    ),
  );
  const created = events.filter((event) => event.event === "created");
  assert.equal(created.length, 1);
  const threadId = created[0].threadId;
  assert.ok(Number.isInteger(threadId) && threadId > 0);
  const exited = events.filter((event) => event.event === "worker-exit");
  assert.equal(exited.length, 1);
  assert.equal(exited[0].threadId, threadId);
  // Worker.terminate() normally reports 1; the Gateway's own graceful exit is separate evidence.
  assert.ok(exited[0].code === 0 || exited[0].code === 1);
  const firstOpen = events.find((event) => event.event === "send" && event.type === "open");
  assert.ok(firstOpen);
  assert.equal(
    firstOpen.expectedBackend,
    true,
    "First SQLite actor is not the shared-state backend",
  );
  const openReply = events.find((event) => event.event === "reply" && event.id === firstOpen.id);
  assert.equal(openReply?.ok, true);
  assert.equal(openReply.transfer, undefined);
  assert.equal(openReply.input, undefined);
  const firstExecute = events.find((event) => event.event === "send" && event.type === "execute");
  assert.ok(firstExecute);
  assert.equal(firstExecute.actor, firstOpen.actor);
  const executeReply = events.find(
    (event) => event.event === "reply" && event.id === firstExecute.id,
  );
  assert.equal(executeReply?.ok, true);
  // Do not label the first framed reply as complete; this fixed small-row probe expects inline replies.
  assert.equal(executeReply.transfer, undefined);
  assert.equal(executeReply.input, undefined);
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".cpuprofile"));
  assert.equal(names.length, 1, "Expected only the first matched worker profile");
  assert.match(
    names[0],
    new RegExp(`^CPU\\.\\d{8}\\.\\d{6}\\.${header.pid}\\.${threadId}\\.\\d+\\.cpuprofile$`, "u"),
  );
  const raw = await fs.readFile(path.join(directory, names[0]));
  const profile = JSON.parse(raw.toString("utf8"));
  assert.ok(
    Number.isFinite(profile.startTime) &&
      profile.startTime > 0 &&
      Number.isFinite(profile.endTime) &&
      profile.endTime > profile.startTime,
  );
  assert.ok(Array.isArray(profile.nodes) && profile.nodes.length > 0);
  const ids = new Set(profile.nodes.map((node) => node.id));
  assert.equal(ids.size, profile.nodes.length);
  assert.ok([...ids].every(Number.isInteger));
  assert.ok(profile.nodes.every((node) => typeof node.callFrame?.functionName === "string"));
  assert.ok(Array.isArray(profile.samples) && profile.samples.length > 0);
  assert.equal(profile.samples.length, profile.timeDeltas.length);
  assert.ok(profile.samples.every((id) => ids.has(id)));
  assert.ok(profile.timeDeltas.every(Number.isFinite));
  const construct = events.find((event) => event.event === "construct-start");
  assert.ok(profile.startTime >= construct.monotonicUs && profile.endTime <= exited[0].monotonicUs);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  return {
    pid: header.pid,
    threadId,
    workerEntry: header.workerEntry,
    backendEntry: header.backendEntry,
    profile: names[0],
    sha256: hash(raw),
    bytes: raw.length,
    eventsSha256: hash(eventsBytes),
    samples: profile.samples.length,
    negativeTimeDeltas: profile.timeDeltas.filter((delta) => delta < 0).length,
    startTimeUs: profile.startTime,
    endTimeUs: profile.endTime,
    firstOpenRoundTripMs: (openReply.monotonicUs - firstOpen.monotonicUs) / 1000,
    firstExecuteRoundTripMs: (executeReply.monotonicUs - firstExecute.monotonicUs) / 1000,
    limitation:
      "Diagnostic sampling and observer overhead; envelope spans include queue/IPC/admission. Not benchmark or precise CPU duration.",
  };
}

export async function verifyInstalledFlow(resultsPath, captureDirectory) {
  const results = JSON.parse(await fs.readFile(resultsPath, "utf8"));
  // Existing d914 owner remains responsible for all Gateway and outer-Job lifecycle assertions.
  assert.equal(results.outcome, "passed");
  assert.equal(results.artifactKind, "installed-package");
  assert.equal(results.measurementMode, "cpu-diagnostic");
  assert.deepEqual(results.errors, []);
  assert.deepEqual(results.before, results.after);
  assert.deepEqual(
    results.samples.map((sample) => sample.phase),
    ["fresh", "established"],
  );
  assert.deepEqual(results.outerSettlement, {
    outcome: "passed",
    beforeCleanup: "dead",
    exitCode: 0,
    joined: true,
  });
  for (const sample of results.samples) {
    assert.equal(sample.outcome, "passed");
    assert.deepEqual(sample.errors, []);
    assert.equal(sample.observations.readyz.status, 200);
    assert.equal(sample.observations.healthz.status, 200);
    assert.equal(sample.observations.hello.ok, true);
    assert.equal(sample.observations.status.response.ok, true);
    assert.equal(sample.observations.health.response.ok, true);
    assert.equal(sample.observations.shutdown.acknowledgment.accepted, true);
  }
  const capture = await verifyWorkerCapture(captureDirectory);
  assert.equal(capture.pid, results.samples[1].observations.launch.pid);
  return {
    resultsPath: path.resolve(resultsPath),
    resultsSha256: createHash("sha256")
      .update(await fs.readFile(resultsPath))
      .digest("hex"),
    runtime: results.runtime,
    host: results.host,
    input: results.input,
    buildInfo: results.buildInfo,
    canonicalInstall: results.before,
    harnessHashes: results.harnessHashes,
    capture,
  };
}

const fixture = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(fixture, "../../..");
const evidence = path.join(repository, ".artifacts/windows-installed-startup");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function sourceBinding() {
  const manifestBytes = await fs.readFile(path.join(fixture, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.baseTooling, "705856070e3ac46e9e12ba4d22f0c72d447edd64");
  assert.equal(manifest.diagnosticTooling, "d9145840b4d20da742924816a8487dca503327a6");
  const files = {};
  for (const [name, expected] of Object.entries(manifest.files)) {
    files[name] = sha256(await fs.readFile(path.join(repository, name)));
    assert.equal(files[name], expected, `Task source changed: ${name}`);
  }
  return { manifestSha256: sha256(manifestBytes), files };
}

// Fixed workflow calls: no arbitrary entry, package, command or capture selection.
export async function bindBefore() {
  assert.equal(process.platform, "win32");
  assert.equal(process.version, "v26.8.2");
  assert.ok(!process.env.NODE_OPTIONS);
  await fs.mkdir(evidence, { recursive: true });
  const before = {
    source: await sourceBinding(),
    runtime: {
      executable: process.execPath,
      version: process.version,
      platform: process.platform,
      sha256: sha256(await fs.readFile(process.execPath)),
    },
  };
  await fs.writeFile(
    path.join(evidence, "sqlite-worker-before.json"),
    JSON.stringify(before, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(JSON.stringify(before));
}

export async function collectAfter() {
  const receipt = { outcome: "failed" };
  try {
    const before = JSON.parse(
      await fs.readFile(path.join(evidence, "sqlite-worker-before.json"), "utf8"),
    );
    receipt.before = before;
    receipt.after = await sourceBinding();
    assert.deepEqual(receipt.after, before.source);
    assert.equal(sha256(await fs.readFile(process.execPath)), before.runtime.sha256);
    const syntheticBytes = await fs.readFile(
      path.join(evidence, "sqlite-worker-synthetic/result.json"),
    );
    const synthetic = JSON.parse(syntheticBytes.toString("utf8"));
    assert.equal(synthetic.runtime, before.runtime.version);
    assert.equal(synthetic.platform, "win32");
    assert.equal(synthetic.executableSha256, before.runtime.sha256);
    assert.deepEqual(synthetic.exit, { code: 0, signal: null, failed: false });
    assert.deepEqual(
      await verifyWorkerCapture(path.join(evidence, "sqlite-worker-synthetic/capture")),
      synthetic.verified,
    );
    receipt.synthetic = { sha256: sha256(syntheticBytes), verified: synthetic.verified };
    const flow = await verifyInstalledFlow(
      path.join(evidence, "results.json"),
      path.join(evidence, "results.json.profiles/sqlite-worker"),
    );
    receipt.flow = flow;
    assert.equal(flow.runtime.sha256, before.runtime.sha256);
    assert.equal(flow.runtime.version, before.runtime.version);
    assert.equal(flow.runtime.platform, "win32");
    const binding = JSON.parse(
      await fs.readFile(path.join(fixture, "package-binding.json"), "utf8"),
    );
    assert.equal(flow.input.sourceSha, binding.sourceSha);
    assert.equal(flow.input.candidate.packageSourceSha, binding.sourceSha);
    assert.equal(flow.input.candidate.sha256, binding.packageSha256);
    assert.deepEqual(flow.input.artifact, {
      id: binding.artifactId,
      runId: binding.runId,
      runAttempt: binding.runAttempt,
      workflowSha: binding.workflowSha,
      digest: binding.artifactDigest,
    });
    receipt.packageBinding = binding;
    receipt.outcome = "passed";
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(
      path.join(evidence, "sqlite-worker-verification.json"),
      JSON.stringify(receipt, null, 2) + "\n",
      { flag: "wx" },
    );
    console.log(JSON.stringify(receipt));
  }
}
