import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  createDesktopProofOutputCapture,
  desktopProofDiagnosticLogging,
  desktopProofAssets,
  desktopProofCommit,
  desktopProofSource,
  desktopProofSshdFailure,
  desktopProofTestReport,
  desktopResizeStages,
  desktopRfbTermination,
  desktopScenarioTermination,
  desktopTerminationLimits,
  encodeDesktopProofPhase,
  exportDesktopResizeProof,
  inspectDesktopSshdRuntimeDirectory,
  readDesktopProofPhase,
  readDesktopProofTestReport,
  sanitizeDesktopResizeProof,
  withDesktopProofCleanup,
  withDesktopTerminationSnapshot,
} from "../../scripts/lib/desktop-resize-proof.mts";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);
const tree = "d".repeat(40);
const size = { width: 1200, height: 850 };
const assets = { "index-fixture.js": "e".repeat(64) };
const closeLine = (overrides: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    level: "info",
    subsystem: "gateway/desktop",
    message: "desktop observer closed",
    trigger: "stream-close",
    closeCode: 1000,
    cleanupCode: 1000,
    sourceKey: "private-source",
    ownerEpoch: "private-owner",
    streamId: "private-stream",
    connId: "private-connection",
    nodeId: "private-node",
    time: "private-time",
    payload: "private-token",
    ...overrides,
  })}\n`;
const proofOutput = (
  stdout: Array<string | Uint8Array> = [],
  stderr: Array<string | Uint8Array> = [],
) => ({ stdout, stderr, retention: "head" as const });
const rawTestReport = (
  message = "AssertionError: private-token",
  metadata: Record<string, unknown> = {},
) => ({
  success: true,
  numTotalTests: 1,
  numFailedTests: 1,
  numFailedTestSuites: 1,
  snapshot: { private: "secret" },
  testResults: [
    {
      name: "/private/workspace/ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
      status: "failed",
      message: "",
      assertionResults: [
        {
          title: "private-title",
          fullName: "private-title",
          status: "failed",
          location: { line: 120, column: 3 },
          meta: { desktopProofPhase: "node-admission", password: "private-token", ...metadata },
          failureMessages: [message],
        },
      ],
    },
  ],
});
const viewerFailure = {
  expected: size,
  lastFramebuffer: { width: 900, height: 500 },
  snapshotStatus: "available",
  pageClosed: false,
  canvasCount: 1,
  snapshotFramebuffer: { width: 900, height: 500 },
  socketCount: 2,
  latestReadyState: 1,
  socketCloses: [{ socketIndex: 0, code: 4000, wasClean: true, category: "takeover" }],
};
const proof = (carrier: "node" | "ssh" = "node") => ({
  carrier,
  gateway: { execution: "built-process", readiness: "readyz", minimal: false },
  node:
    carrier === "node"
      ? {
          deviceId: "private-node-id",
          passwordAbsentFromObserve: true,
          disconnectClosedViewer: true,
        }
      : null,
  observer: {
    evidence: "endpoint-marker-brackets",
    keyboardForwardedBytes: 0,
    resizeForwardedBytes: 0,
  },
  assets,
  samples: desktopResizeStages.map((stage) => ({ stage, ...size })),
  pixels: { distinctSampledColors: 100 },
  provenance: { privatePath: "/private/fixture" },
  hello: { token: "private-token" },
});

describe("desktop proof identity and public evidence", () => {
  it("enables structured info only for opted-in children, overriding an inherited silent level", () => {
    const inherited = { OPENCLAW_LOG_LEVEL: "silent", UNRELATED: "unchanged" };
    const enabled = desktopProofDiagnosticLogging(true);
    expect({ ...inherited, ...enabled.env }).toEqual({
      OPENCLAW_LOG_LEVEL: "info",
      UNRELATED: "unchanged",
    });
    expect(enabled.logging).toEqual({ consoleStyle: "json", consoleLevel: "info" });
    expect({ ...inherited, ...desktopProofDiagnosticLogging(false).env }).toEqual(inherited);
    expect(desktopProofDiagnosticLogging(false).logging).toBeUndefined();
  });

  it("projects actual info producers separately without private identities or inferred correlation", () => {
    const evidence = desktopScenarioTermination(
      proofOutput(
        [
          closeLine(),
          closeLine({
            subsystem: "gateway/node-stream",
            message: "node stream closed",
            streamKind: "desktop",
            trigger: "websocket-close",
            closeCode: 1006,
          }),
        ],
        [
          closeLine({ level: "debug" }),
          closeLine({
            subsystem: "gateway/node-stream",
            message: "node stream closed",
            streamKind: "portal",
            trigger: "websocket-close",
          }),
        ],
      ),
      proofOutput(
        [],
        [
          closeLine({
            subsystem: "node-host/stream",
            message: "node stream closed",
            streamKind: "desktop",
            trigger: "target-close",
          }),
        ],
      ),
      true,
    );
    expect(evidence.status).toBe("captured");
    if (evidence.status !== "captured") throw new Error("Missing termination projection");
    expect(
      evidence.gateway.records.map(({ producer, trigger, closeCode }) => ({
        producer,
        trigger,
        closeCode,
      })),
    ).toEqual([
      { producer: "gateway-observer", trigger: "stream-close", closeCode: 1000 },
      { producer: "gateway-broker", trigger: "websocket-close", closeCode: 1006 },
    ]);
    expect(evidence.node.records).toEqual([
      {
        stream: "stderr",
        ordinal: 1,
        producer: "node-transport",
        trigger: "target-close",
        closeCode: 1000,
        cleanupCode: null,
      },
    ]);
    expect(evidence).toMatchObject({
      boundary: "before-scenario-cleanup",
      signalAborted: true,
      correlation: "unavailable",
      writerMayBeBuffered: true,
    });
    expect(JSON.stringify(evidence)).not.toContain("private-");
    const unknown = desktopScenarioTermination(
      proofOutput([closeLine({ trigger: "private-trigger", closeCode: "private-code" })]),
      undefined,
      false,
    );
    expect(unknown.status === "captured" && unknown.gateway.records[0]).toMatchObject({
      trigger: "unknown",
      closeCode: null,
    });
    expect(unknown.status === "captured" && unknown.node.status).toBe("unavailable");
    expect(JSON.stringify(unknown)).not.toContain("private-");
  });

  it("frames split UTF-8 within each pipe and never joins partial stdout to stderr", () => {
    const bytes = Buffer.from(closeLine({ payload: "private-🦊" }));
    const split = bytes.indexOf(Buffer.from("🦊")) + 1;
    const capture = createDesktopProofOutputCapture(desktopTerminationLimits.node);
    capture.append("stdout", bytes.subarray(0, split));
    capture.append("stderr", Buffer.from("not-json\n"));
    capture.append("stdout", bytes.subarray(split));
    const evidence = desktopScenarioTermination(capture.snapshot(), undefined, false);
    expect(evidence.status === "captured" && evidence.gateway.records).toHaveLength(1);
    expect(
      evidence.status === "captured" &&
        evidence.gateway.streams.map(({ malformedLines }) => malformedLines),
    ).toEqual([0, 1]);
    const partial = desktopScenarioTermination(
      proofOutput([bytes.subarray(0, split)], [bytes.subarray(split)]),
      undefined,
      false,
    );
    expect(partial.status === "captured" && partial.gateway.records).toEqual([]);
    expect(partial.status === "captured" && partial.gateway.streams[0]?.partialLine).toBe(true);
    expect(partial.status === "captured" && partial.gateway.streams[1]?.malformedLines).toBe(1);
  });

  it("retains fixed TigerVNC first-reason categories at the later daemon boundary", () => {
    const evidence = desktopRfbTermination(
      proofOutput([
        " Connections: accepted: private-endpoint\n",
        " VNCSConnST: closing private-endpoint: Clean disconnection\n",
        " VNCSConnST: closing private-endpoint: Client does not support desktop resize\n",
        " VNCSConnST: closing private-endpoint: private-error\n",
        " Connections: closed: private-endpoint\n",
      ]),
      undefined,
    );
    expect(evidence.status).toBe("captured");
    if (evidence.status !== "captured") throw new Error("Missing RFB projection");
    expect(evidence.boundary).toBe("after-test-process-join-before-daemon-cleanup");
    expect(evidence.correlation).toBe("unavailable");
    expect(evidence.dynamic.records.map(({ trigger }) => trigger)).toEqual([
      "clean-disconnection",
      "resize-unsupported",
      "other-close",
    ]);
    expect(evidence.fixed.status).toBe("unavailable");
    expect(JSON.stringify(evidence)).not.toContain("private-");
  });

  it("caps all producer inputs and records while reserving the RFB share for each carrier", () => {
    const gatewayLine = closeLine();
    const nodeLine = closeLine({
      subsystem: "node-host/stream",
      message: "node stream closed",
      streamKind: "desktop",
      trigger: "target-close",
    });
    const rfbLine = " VNCSConnST: closing private-endpoint: Clean disconnection\n";
    let invocationBytes = 0;
    let invocationRecords = 0;
    for (let carrier = 0; carrier < 2; carrier += 1) {
      const scenario = desktopScenarioTermination(
        proofOutput([gatewayLine.repeat(20_000)], [gatewayLine.repeat(20_000)]),
        proofOutput([nodeLine.repeat(20_000)], [nodeLine.repeat(20_000)]),
        false,
      );
      const rfb = desktopRfbTermination(
        proofOutput([rfbLine.repeat(20_000)], [rfbLine.repeat(20_000)]),
        proofOutput([rfbLine.repeat(20_000)], [rfbLine.repeat(20_000)]),
      );
      if (scenario.status !== "captured" || rfb.status !== "captured")
        throw new Error("Missing bounded projection");
      const outputs = [scenario.gateway, scenario.node, rfb.dynamic, rfb.fixed];
      const scanned = outputs.reduce(
        (sum, output) =>
          sum + output.streams.reduce((bytes, stream) => bytes + stream.scannedBytes, 0),
        0,
      );
      const records = outputs.reduce((sum, output) => sum + output.records.length, 0);
      expect(scanned).toBe(1024 ** 2);
      expect(outputs.map(({ records }) => records.length)).toEqual([32, 16, 8, 8]);
      expect(
        outputs.every(({ streams }) =>
          streams.every((stream) => stream.inputLimited && stream.recordsLimited),
        ),
      ).toBe(true);
      expect(
        Buffer.byteLength(JSON.stringify({ termination: scenario, rfbTermination: rfb })),
      ).toBeLessThanOrEqual(32 * 1024);
      invocationBytes += scanned;
      invocationRecords += records;
    }
    expect(invocationBytes).toBe(2 * 1024 ** 2);
    expect(invocationRecords).toBe(128);
  });

  it("reports oversized, incomplete, malformed and truncated inputs without claiming no event", () => {
    const capture = createDesktopProofOutputCapture(64);
    capture.append("stdout", Buffer.alloc(1024 ** 2, 120));
    capture.append("stderr", Buffer.alloc(1024 ** 2, 120));
    const captured = capture.snapshot();
    expect(captured.stdout[0]).toHaveLength(32);
    expect(captured.stderr[0]).toHaveLength(32);
    expect(captured).toMatchObject({
      stdoutTruncated: true,
      stderrTruncated: true,
      retention: "head",
    });
    const evidence = desktopScenarioTermination(
      proofOutput([
        `${"x".repeat(desktopTerminationLimits.line + 1)}\n`,
        "not-json\n",
        closeLine(),
        "incomplete",
      ]),
      undefined,
      false,
    );
    expect(evidence.status === "captured" && evidence.gateway.streams[0]).toMatchObject({
      oversizedLines: 1,
      malformedLines: 1,
      partialLine: true,
    });
    const tail = Object.assign([closeLine(), closeLine()], { truncated: true });
    const truncated = desktopScenarioTermination(
      { stdout: tail, stderr: [], retention: "tail" },
      undefined,
      false,
    );
    expect(truncated.status === "captured" && truncated.gateway.records).toHaveLength(1);
    expect(truncated.status === "captured" && truncated.gateway.streams[0]).toMatchObject({
      partialPrefix: true,
      retainedTruncation: true,
    });
    const noNewline = desktopScenarioTermination(
      proofOutput(["x".repeat(1024 ** 2)]),
      undefined,
      false,
    );
    expect(noNewline.status === "captured" && noNewline.gateway.streams[0]).toMatchObject({
      inputLimited: true,
      partialLine: true,
    });
    const emptyChunks = desktopScenarioTermination(
      proofOutput(Array.from({ length: 4097 }, () => "")),
      undefined,
      false,
    );
    expect(emptyChunks.status === "captured" && emptyChunks.gateway.streams[0]?.inputLimited).toBe(
      true,
    );
    const tinyLines = desktopScenarioTermination(
      proofOutput(["\n".repeat(4097)]),
      undefined,
      false,
    );
    expect(tinyLines.status === "captured" && tinyLines.gateway.streams[0]).toMatchObject({
      inputLimited: true,
      malformedLines: 4096,
    });
  });

  it("freezes once before cleanup and retains that snapshot in later owner checkpoints", async () => {
    const capture = createDesktopProofOutputCapture(1024);
    capture.append("stdout", Buffer.from(closeLine()));
    let evidence: ReturnType<typeof desktopScenarioTermination> | undefined;
    let freezes = 0;
    const value = await withDesktopTerminationSnapshot(
      async () => "passed",
      () => {
        freezes += 1;
        evidence = desktopScenarioTermination(capture.snapshot(), undefined, false);
      },
    );
    const before = JSON.stringify(evidence);
    capture.append("stdout", Buffer.from(closeLine({ trigger: "owner-close" })));
    expect(value).toBe("passed");
    expect(freezes).toBe(1);
    expect(JSON.stringify(evidence)).toBe(before);
    const root = dirs.make("desktop-termination-checkpoint-");
    const file = path.join(root, "desktop-phase.json");
    await writeFile(
      file,
      encodeDesktopProofPhase(
        "resize-matrix",
        { gateway: "closed", endpointTap: "closed" },
        evidence,
      ),
    );
    expect(await readDesktopProofPhase(file)).toMatchObject({
      status: "available",
      owners: { gateway: "closed", endpointTap: "closed" },
      termination: evidence,
    });
    expect(Buffer.byteLength(await readFile(file))).toBeLessThanOrEqual(
      desktopTerminationLimits.checkpoint,
    );
  });

  it("keeps valid phase and owners when optional evidence is invalid and rejects oversized checkpoint files", async () => {
    const root = dirs.make("desktop-termination-invalid-");
    const file = path.join(root, "desktop-phase.json");
    const owners = { gateway: "closed", endpointTap: "closed" };
    await writeFile(
      file,
      JSON.stringify({
        lastObservedPhase: "resize-matrix",
        owners,
        termination: { status: "private-error" },
      }),
    );
    expect(await readDesktopProofPhase(file)).toEqual({
      status: "available",
      lastObservedPhase: "resize-matrix",
      owners,
      termination: { status: "invalid" },
    });
    const evidence = desktopScenarioTermination(proofOutput([closeLine()]), undefined, false);
    const encoded = encodeDesktopProofPhase("resize-matrix", owners, {
      ...evidence,
      unknown: "private-token".repeat(10_000),
    });
    expect(encoded).not.toContain("private-");
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(desktopTerminationLimits.checkpoint);
    await writeFile(
      file,
      `${JSON.stringify({ lastObservedPhase: "resize-matrix", owners })}${" ".repeat(desktopTerminationLimits.checkpoint)}`,
    );
    expect((await readDesktopProofPhase(file)).status).toBe("invalid");
    const link = path.join(root, "symlink.json");
    await symlink(file, link);
    expect((await readDesktopProofPhase(link)).status).toBe("invalid");
  });

  it("preserves original failure and cleanup ordering when diagnostic projection or persistence fails", async () => {
    const root = dirs.make("desktop-termination-errors-");
    const primary = new Error("original assertion");
    const cleanup = new Error("original cleanup");
    const invalidOutput = {
      get stdout(): string[] {
        throw new Error("private-projection-error");
      },
      stderr: [],
      retention: "head" as const,
    };
    expect(desktopScenarioTermination(invalidOutput, undefined, false)).toEqual({
      status: "unavailable",
    });
    for (const freeze of [
      () => {
        throw new Error("private-projection-error");
      },
      () => writeFileSync(root, "unwritable checkpoint"),
    ]) {
      const failure = await withDesktopProofCleanup(
        () =>
          withDesktopTerminationSnapshot(async () => {
            throw primary;
          }, freeze),
        async () => {
          throw cleanup;
        },
        () => {},
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
    }
    const missing = path.join(root, "missing.json");
    const failure = await withDesktopProofCleanup(
      async () => {
        throw primary;
      },
      async () => {
        expect((await readDesktopProofPhase(missing)).status).toBe("unavailable");
        throw cleanup;
      },
      () => {},
    ).catch((error: unknown) => error);
    expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
  });

  it("keeps the UI phase contract narrower than arbitrary reporter strings", () => {
    type Phase = Exclude<
      ReturnType<typeof desktopProofTestReport>["files"][number]["assertions"][number]["phase"],
      "unknown"
    >;
    expectTypeOf<"node-admission">().toExtend<Phase>();
    expectTypeOf<"file-loaded">().toExtend<Phase>();
    expectTypeOf<"unknown">().not.toExtend<Phase>();
    expectTypeOf<"misspelled-phase">().not.toExtend<Phase>();
  });

  it("records sshd runtime directory facts without modifying missing or unsafe paths", async () => {
    const root = dirs.make("desktop-sshd-runtime-");
    const directory = path.join(root, "runtime");
    expect(await inspectDesktopSshdRuntimeDirectory(directory)).toEqual({
      status: "missing",
      symlink: null,
      directory: null,
      rootOwned: null,
      groupOrWorldWritable: null,
    });
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(directory, { mode: 0o700 });
    expect(await inspectDesktopSshdRuntimeDirectory(directory)).toMatchObject({
      status: "present",
      symlink: false,
      directory: true,
      rootOwned: (await stat(directory)).uid === 0,
      groupOrWorldWritable: process.platform === "win32" ? expect.any(Boolean) : false,
    });
    const link = path.join(root, "runtime-link");
    await symlink(directory, link, "dir");
    expect(await inspectDesktopSshdRuntimeDirectory(link)).toMatchObject({
      symlink: true,
      directory: true,
    });
    if (process.platform !== "win32") {
      await chmod(directory, 0o770);
      expect(await inspectDesktopSshdRuntimeDirectory(directory)).toMatchObject({
        groupOrWorldWritable: true,
      });
      expect((await stat(directory)).mode & 0o777).toBe(0o770);
    }
    const file = path.join(root, "not-a-directory");
    await writeFile(file, "private contents");
    expect(await inspectDesktopSshdRuntimeDirectory(file)).toMatchObject({ directory: false });
  });

  it.each([
    ["Missing privilege separation directory: /private/runtime\r\n", "privsep-directory-missing"],
    [
      "/private/runtime must be owned by root and not group or world-writable.\r\n",
      "privsep-directory-permissions",
    ],
    ["Privilege separation user private-user does not exist\r\n", "privsep-user-missing"],
    ["sshd: no hostkeys available -- exiting.\n", "host-key-unavailable"],
    ["private config failed at private path", "unclassified"],
    ["x".repeat(64 * 1024 + 1), "output-too-large"],
  ])("exports only a fixed sshd failure category (%#)", (stderr, category) => {
    expect(desktopProofSshdFailure(stderr)).toBe(category);
    expect(desktopProofSshdFailure(stderr)).not.toMatch(/private|runtime|user$/u);
  });

  it("preserves the sshd command failure and private log write when projection fails", async () => {
    const child = new Error("sshd-config failed");
    const projection = new Error("projection failed");
    const recorded: unknown[] = [];
    const record = (error: unknown) => {
      recorded.push(error);
    };
    let privateLogSaved = false;
    const failure = await withDesktopProofCleanup(
      async () => {
        throw child;
      },
      () =>
        withDesktopProofCleanup(
          async () => {
            expect(recorded[0]).toBe(child);
            throw projection;
          },
          async () => {
            privateLogSaved = true;
          },
          record,
        ),
      record,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(child);
    expect((failure as AggregateError).errors[1].errors[0]).toBe(projection);
    expect(privateLogSaved).toBe(true);
  });

  it("publishes fixed phases and known failure locations, not raw reporter content", () => {
    const result = desktopProofTestReport(
      rawTestReport(
        "AssertionError: private-token actual=secret expected=password\n at /private/workspace/test/e2e/qa-lab/runtime/skill-library-node-process.ts:42:9\n at /private/secret.ts:1:2\n https://private.invalid/token",
      ),
    );
    expect(result).toMatchObject({
      failedTests: 1,
      files: [
        {
          file: "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
          assertions: [
            {
              index: 0,
              phase: "node-admission",
              declarationLocation: { line: 120, column: 3 },
              failures: [
                {
                  category: "AssertionError",
                  failureLocations: [
                    {
                      file: "test/e2e/qa-lab/runtime/skill-library-node-process.ts",
                      line: 42,
                      column: 9,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private|token|secret|password|actual|expected|success|title|https/u,
    );
  });

  it.each([
    ["Error: Test timed out in 120000ms.\nprivate pending operation", "test-timeout"],
    ["Error: Test timed out in 120000ms while waiting for private operation.", "test-timeout"],
    ["Error: Hook timed out in 60000ms.\nprivate pending operation", "hook-timeout"],
    ["Error: a timeout might have happened after 174000ms", "test-error"],
  ])("classifies only the emitted timeout contract: %s", (message, category) => {
    const result = desktopProofTestReport(rawTestReport(message));
    expect(result.files[0]?.assertions[0]?.failures[0]?.category).toBe(category);
  });

  it.each([
    { label: "mismatch", override: {} },
    {
      label: "missing canvas",
      override: { canvasCount: 0, lastFramebuffer: null, snapshotFramebuffer: null },
    },
    { label: "multiple canvases", override: { canvasCount: 2, snapshotFramebuffer: null } },
    { label: "no closed sockets", override: { socketCloses: [] } },
    {
      label: "closed reconnect",
      override: {
        canvasCount: 0,
        snapshotFramebuffer: null,
        socketCount: 3,
        latestReadyState: 3,
        socketCloses: [
          { socketIndex: 0, code: 1000, wasClean: true, category: "unknown" },
          { socketIndex: 1, code: 4000, wasClean: true, category: "takeover" },
          { socketIndex: 2, code: 1006, wasClean: false, category: "unknown" },
        ],
      },
    },
    {
      label: "zero framebuffer",
      override: {
        lastFramebuffer: { width: 0, height: 0 },
        snapshotFramebuffer: { width: 0, height: 0 },
      },
    },
    {
      label: "unavailable snapshot",
      override: {
        snapshotStatus: "unavailable",
        pageClosed: true,
        canvasCount: null,
        snapshotFramebuffer: null,
        socketCount: null,
        latestReadyState: null,
        socketCloses: null,
      },
    },
    {
      label: "timed-out snapshot",
      override: {
        snapshotStatus: "timed-out",
        canvasCount: null,
        snapshotFramebuffer: null,
        socketCount: null,
        latestReadyState: null,
        socketCloses: null,
      },
    },
  ])("retains bounded viewer failure diagnostics: $label", async ({ override }) => {
    const diagnostics = { ...viewerFailure, ...override };
    const root = dirs.make("desktop-viewer-report-");
    const file = path.join(root, "report.json");
    await writeFile(
      file,
      JSON.stringify(
        rawTestReport(undefined, {
          desktopViewerResizeFailure: {
            ...diagnostics,
            expected: { ...diagnostics.expected, privateText: "private-token" },
            socketCloses:
              diagnostics.socketCloses?.map((event) => ({
                ...event,
                reason: "control-taken:private-operator",
                url: "https://example.invalid/private-token",
              })) ?? null,
            html: "private-dom",
            socketUrl: "https://example.invalid/private-token",
            error: "private-error",
          },
        }),
      ),
    );
    const report = await readDesktopProofTestReport(file);
    expect(report.files[0]?.assertions[0]).toMatchObject({ viewerResize: diagnostics });
    expect(JSON.stringify(report)).not.toMatch(/private|token|password|html|socketUrl|https/u);
  });

  it.each([
    { snapshotStatus: "private-token" },
    { pageClosed: 0 },
    { canvasCount: -1 },
    { canvasCount: 10_001 },
    { socketCount: Number.NaN },
    { latestReadyState: 4 },
    { socketCloses: undefined },
    { socketCloses: "private-token" },
    { socketCloses: Array.from({ length: 9 }, () => viewerFailure.socketCloses[0]) },
    ...[
      { socketIndex: -1 },
      { socketIndex: 10_000 },
      { code: 65_536 },
      { code: 1000.5 },
      { wasClean: 1 },
      { category: "control-taken:private-operator" },
    ].map((event) => ({ socketCloses: [{ ...viewerFailure.socketCloses[0], ...event }] })),
    { expected: { width: Infinity, height: 850 } },
    { lastFramebuffer: { width: 0.5, height: 0 } },
    { snapshotFramebuffer: { width: 8193, height: 0 } },
  ])("rejects invalid viewer diagnostic bounds: %j", (override) => {
    expect(() =>
      desktopProofTestReport(
        rawTestReport(undefined, {
          desktopViewerResizeFailure: { ...viewerFailure, ...override },
        }),
      ),
    ).toThrow();
  });

  it("leaves successful reporter output unchanged even with failure metadata", () => {
    const report = rawTestReport(undefined, { desktopViewerResizeFailure: viewerFailure });
    report.numFailedTests = 0;
    report.numFailedTestSuites = 0;
    report.testResults[0]!.status = "passed";
    report.testResults[0]!.assertionResults[0]!.status = "passed";
    report.testResults[0]!.assertionResults[0]!.failureMessages = [];
    expect(desktopProofTestReport(report).files[0]?.assertions[0]).toEqual({
      index: 0,
      status: "passed",
      phase: "node-admission",
      declarationLocation: { line: 120, column: 3 },
      failures: [],
    });
  });

  it("rejects unknown report files and excessive counts, and ignores unknown metadata phases", () => {
    const report = rawTestReport();
    report.testResults[0]!.assertionResults[0]!.meta.desktopProofPhase = "private-token";
    expect(desktopProofTestReport(report).files[0]?.assertions[0]?.phase).toBe("unknown");
    expect(() => desktopProofTestReport({ ...report, numTotalTests: 17 })).toThrow();
    report.testResults[0]!.name = "/private/other.test.ts";
    expect(() => desktopProofTestReport(report)).toThrow();
  });

  it("retains the observed phase and child timeout when the terminal report is missing and export fails", async () => {
    const root = dirs.make("desktop-report-failure-");
    const checkpoint = path.join(root, "desktop-phase.json");
    await writeFile(checkpoint, JSON.stringify({ lastObservedPhase: "node-admission" }));
    const child = Object.assign(new Error("test-node failed"), { code: "ETIMEDOUT" });
    const exporting = new Error("export failed");
    let lastObserved: Awaited<ReturnType<typeof readDesktopProofPhase>> | undefined;
    const recorded: unknown[] = [];
    const record = (error: unknown) => {
      recorded.push(error);
    };
    const failure = await withDesktopProofCleanup(
      async () => {
        throw child;
      },
      () =>
        withDesktopProofCleanup(
          async () => {
            expect(recorded[0]).toBe(child);
            lastObserved = await readDesktopProofPhase(checkpoint);
            await readDesktopProofTestReport(path.join(root, "missing.json"));
          },
          async () => {
            throw exporting;
          },
          record,
        ),
      record,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toBe(child);
    expect(aggregate.errors[1].errors[0]).toMatchObject({ code: "ENOENT" });
    expect(aggregate.errors[1].errors[1]).toBe(exporting);
    expect(lastObserved).toEqual({
      status: "available",
      lastObservedPhase: "node-admission",
      owners: null,
    });
  });

  it("projects only known phases from bounded regular checkpoints", async () => {
    const root = dirs.make("desktop-private-phase-");
    const file = path.join(root, "desktop-phase.json");
    expect(await readDesktopProofPhase(file)).toEqual({
      status: "unavailable",
      lastObservedPhase: null,
      owners: null,
    });
    await writeFile(file, JSON.stringify({ lastObservedPhase: "file-loaded", secret: "private" }));
    expect(await readDesktopProofPhase(file)).toEqual({
      status: "available",
      lastObservedPhase: "file-loaded",
      owners: null,
    });
    const link = path.join(root, "linked-phase.json");
    await symlink(file, link);
    expect(await readDesktopProofPhase(link)).toEqual({
      status: "invalid",
      lastObservedPhase: null,
      owners: null,
    });
    expect(await readDesktopProofPhase(root)).toEqual({
      status: "invalid",
      lastObservedPhase: null,
      owners: null,
    });
    for (const content of ["{", '{"lastObservedPhase":"private-token"}', "x".repeat(1025)]) {
      await writeFile(file, content);
      expect(await readDesktopProofPhase(file)).toEqual({
        status: "invalid",
        lastObservedPhase: null,
        owners: null,
      });
    }
  });

  it("projects explicit resource ownership without inferring detached-process cleanup", async () => {
    const root = dirs.make("desktop-process-ownership-");
    const file = path.join(root, "desktop-phase.json");
    for (const gateway of ["not-started", "owned", "closed"] as const) {
      await writeFile(
        file,
        JSON.stringify({
          lastObservedPhase: "gateway-start",
          owners: { gateway, endpointTap: "owned", privatePath: "/private/fixture" },
          startupAtAbort: { currentPhase: "private-token" },
        }),
      );
      expect(await readDesktopProofPhase(file)).toEqual({
        status: "available",
        lastObservedPhase: "gateway-start",
        owners: { gateway, endpointTap: "owned" },
      });
    }
    for (const owners of [
      null,
      { gateway: "closed" },
      { gateway: "private", endpointTap: "closed" },
    ]) {
      await writeFile(file, JSON.stringify({ lastObservedPhase: "gateway-start", owners }));
      expect((await readDesktopProofPhase(file)).owners).toBeNull();
    }
  });

  it("accepts only bounded regular reporter files", async () => {
    const root = dirs.make("desktop-private-report-");
    const file = path.join(root, "report.json");
    await writeFile(file, JSON.stringify(rawTestReport()));
    expect((await readDesktopProofTestReport(file)).failedTests).toBe(1);
    const link = path.join(root, "report-link.json");
    await symlink(file, link);
    await expect(readDesktopProofTestReport(link)).rejects.toThrow("regular file");
    await writeFile(file, "{");
    await expect(readDesktopProofTestReport(file)).rejects.toThrow();
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
    await expect(readDesktopProofTestReport(file)).rejects.toThrow("bounded");
  });

  it("launches only the owned foreground window manager, without session autostart", async () => {
    const bootstrap = await readFile(
      new URL("../../scripts/test-desktop-resize-real.mts", import.meta.url),
      "utf8",
    );
    expect(bootstrap).toContain('daemon(`wm-${display}`, "openbox", ["--sm-disable"], env)');
    expect(bootstrap).not.toMatch(
      /"(?:startxfce4|xfce4-session|openbox-session|dbus-run-session|--startup)"/u,
    );
  });

  it("retains child ownership when both private logging and export fail", async () => {
    const child = Object.assign(new Error("child cleanup failed"), {
      processTreeState: "live",
      code: "EPROCESSGROUP_CLEANUP_FAILED",
    });
    const logging = new Error("log write failed");
    const exporting = new Error("export failed");
    let unjoined = false;
    const record = (error: unknown) => {
      unjoined ||= hasUnjoinedWork(error);
    };
    const failure = await withDesktopProofCleanup(
      () =>
        withDesktopProofCleanup(
          async () => {
            throw child;
          },
          async () => {
            expect(unjoined).toBe(true);
            throw logging;
          },
          record,
        ),
      async () => {
        expect(unjoined).toBe(true);
        throw exporting;
      },
      record,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0].errors).toEqual([child, logging]);
    expect(aggregate.errors[1]).toBe(exporting);
    expect(hasUnjoinedWork(failure)).toBe(true);
    expect(unjoined).toBe(true);
  });

  it.each(["entries", "bytes"] as const)(
    "shares the %s budget across node and SSH",
    async (limit) => {
      const root = dirs.make("desktop-shared-budget-");
      const input = path.join(root, "input");
      await mkdir(input);
      const data = JSON.stringify(assets);
      await writeFile(path.join(input, "served-assets.json"), data);
      const budget = {
        entries: limit === "entries" ? 255 : 0,
        bytes: limit === "bytes" ? 64 * 1024 ** 2 - Buffer.byteLength(data) : 0,
      };
      await exportDesktopResizeProof(input, path.join(root, "node"), "node", budget);
      await expect(
        exportDesktopResizeProof(input, path.join(root, "ssh"), "ssh", budget),
      ).rejects.toThrow(/bound/u);
    },
  );
  it("distinguishes literal head proof from GitHub merge-tree proof", () => {
    expect(
      desktopProofSource({ head, tree, parents: [base] }, { checkout: head, head, base }).kind,
    ).toBe("pr-head");
    expect(
      desktopProofSource(
        { head: merge, tree, parents: [base, head] },
        { checkout: merge, head, base },
      ),
    ).toMatchObject({
      kind: "pr-merge",
      prHead: head,
      prEventBase: base,
      testedBase: base,
      head: merge,
    });
    expect(desktopProofSource({ head, tree, parents: [base] }, { checkout: head }).kind).toBe(
      "checkout",
    );
  });

  it("reads actual merge parents at a depth-one Git boundary without conflating the event base", async () => {
    const root = dirs.make("desktop-shallow-source-");
    const git = (args: string[], input?: string) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: root,
        input,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test Author",
          GIT_AUTHOR_EMAIL: "author@example.invalid",
          GIT_COMMITTER_NAME: "Test Committer",
          GIT_COMMITTER_EMAIL: "committer@example.invalid",
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
        },
      }).trim();
    git(["init", "--quiet"]);
    const objectTree = git(["mktree"], "");
    const eventBase = git(["commit-tree", objectTree, "-m", "event base"]);
    const testedBase = git(["commit-tree", objectTree, "-p", eventBase, "-m", "tested base"]);
    const prHead = git(["commit-tree", objectTree, "-p", eventBase, "-m", "PR head"]);
    const checkout = git([
      "commit-tree",
      objectTree,
      "-p",
      testedBase,
      "-p",
      prHead,
      "-m",
      "test merge",
    ]);
    git(["update-ref", "HEAD", checkout]);
    await writeFile(path.join(root, ".git", "shallow"), `${checkout}\n`);
    expect(git(["rev-parse", "--is-shallow-repository"])).toBe("true");
    expect(git(["show", "-s", "--format=%P", "HEAD"])).toBe("");
    const observedHead = git(["rev-parse", "--verify", "HEAD"]);
    const actual = desktopProofCommit(observedHead, git(["cat-file", "commit", observedHead]));
    expect(desktopProofSource(actual, { checkout, head: prHead, base: eventBase })).toEqual({
      head: checkout,
      tree: objectTree,
      parents: [testedBase, prHead],
      kind: "pr-merge",
      prHead,
      prEventBase: eventBase,
      testedBase,
    });
  });

  it("reads only raw commit headers, not signature continuations or the message", () => {
    expect(
      desktopProofCommit(
        merge,
        `tree ${tree}\nparent ${base}\nparent ${head}\ngpgsig signature\n parent ${merge}\n\nparent ${merge}\n`,
      ),
    ).toEqual({ head: merge, tree, parents: [base, head] });
  });

  it.each([[], [base], [base, merge], [base, head, merge]].map((parents) => ({ parents })))(
    "rejects unbound actual merge parents: $parents",
    ({ parents }) => {
      expect(() =>
        desktopProofSource({ head: merge, tree, parents }, { checkout: merge, head, base }),
      ).toThrow();
    },
  );

  it.each([
    { checkout: base, head, base },
    { checkout: merge, head: base, base: head },
    { checkout: merge, head },
  ])("rejects source drift and unbound PR parents: %j", (expected) => {
    expect(() =>
      desktopProofSource({ head: merge, tree, parents: [base, head] }, expected),
    ).toThrow();
  });

  it.each(["node", "ssh"] as const)("exports only named %s facts", (carrier) => {
    const safe = sanitizeDesktopResizeProof(proof(carrier), carrier);
    expect(JSON.stringify(safe)).not.toMatch(/private|hello|token|deviceId/u);
    expect(safe.carrier).toBe(carrier);
    expect(safe.samples).toHaveLength(5);
  });

  it.each([
    { node: null },
    { node: { passwordAbsentFromObserve: true, disconnectClosedViewer: false } },
    { observer: { keyboardForwardedBytes: 1, resizeForwardedBytes: 0 } },
    { gateway: { execution: "built-process", readiness: "readyz", minimal: true } },
    { observer: { evidence: "filter-spy", keyboardForwardedBytes: 0, resizeForwardedBytes: 0 } },
    { samples: [] },
    { pixels: { distinctSampledColors: 8 } },
  ])("rejects incomplete or failed node proof: %j", (invalid) => {
    expect(() => sanitizeDesktopResizeProof({ ...proof(), ...invalid }, "node")).toThrow();
  });

  it("rejects asset paths and non-digests", () => {
    expect(() => desktopProofAssets({ "../index.js": "e".repeat(64) })).toThrow();
    expect(() => desktopProofAssets({ "index.js": "private" })).toThrow();
  });

  it("exports a complete bounded allowlist without raw diagnostics or metadata", async () => {
    const root = dirs.make("desktop-public-proof-");
    const input = path.join(root, "input");
    const output = path.join(root, "public");
    const nested = path.join(input, "desktop-suite");
    await mkdir(nested, { recursive: true });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path.join(nested, "01-fit.png"), png);
    for (const stage of desktopResizeStages) {
      await writeFile(path.join(nested, `${stage}.png`), png);
      await writeFile(
        path.join(nested, `${stage}-geometry.json`),
        JSON.stringify({
          stage,
          expected: size,
          guest: size,
          canvas: size,
          matchOffered: true,
          hello: { token: "private" },
        }),
      );
    }
    await writeFile(path.join(nested, "served-assets.json"), JSON.stringify(assets));
    await writeFile(path.join(nested, "resize-proof.json"), JSON.stringify(proof()));
    await writeFile(path.join(nested, "connection-diagnostics.json"), "private-token");
    expect((await exportDesktopResizeProof(input, output, "node")).complete).toBe(true);
    expect(await readdir(output)).toHaveLength(13);
    expect(await readFile(path.join(output, "resize-proof.json"), "utf8")).not.toMatch(
      /private|hello|deviceId/u,
    );
    expect(await readFile(path.join(output, "02-panel-geometry.json"), "utf8")).not.toContain(
      "hello",
    );
  });

  it("does not turn a skipped test into completed proof", async () => {
    const root = dirs.make("desktop-empty-proof-");
    const input = path.join(root, "input");
    await mkdir(input);
    expect((await exportDesktopResizeProof(input, path.join(root, "public"), "ssh")).complete).toBe(
      false,
    );
  });

  it("rejects symlinks instead of publishing their targets", async () => {
    const root = dirs.make("desktop-symlink-proof-");
    const input = path.join(root, "input");
    await mkdir(input);
    await writeFile(path.join(root, "secret"), "private-token");
    await symlink(path.join(root, "secret"), path.join(input, "resize-proof.json"));
    await expect(
      exportDesktopResizeProof(input, path.join(root, "public"), "node"),
    ).rejects.toThrow("regular-file");
  });
});
