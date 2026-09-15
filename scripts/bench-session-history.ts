// Synthetic session-history owner benchmark. No operator state is read or changed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { TranscriptEvent } from "../src/config/sessions/session-accessor.sqlite-contract.js";
import type { SessionTranscriptDisplayDeltaResult } from "../src/config/sessions/session-accessor.sqlite-history-events.js";
import { parseStrictIntegerOption } from "./lib/strict-integer-option.ts";

const profiles = {
  small: { messages: 80, markers: false, reset: false },
  long: { messages: 10_000, markers: false, reset: false },
  sparse: { messages: 10_000, markers: false, reset: false },
  markers: { messages: 10_000, markers: true, reset: false },
  reset: { messages: 10_000, markers: true, reset: true },
  trailing: { messages: 5_000, markers: false, reset: false },
} as const;
type Profile = keyof typeof profiles;
const deltaCases = {
  "visible-1": { markers: 1, display: true, reset: false },
  "visible-8": { markers: 8, display: true, reset: false },
  "visible-64": { markers: 64, display: true, reset: false },
  "visible-1024": { markers: 1024, display: true, reset: false },
  "plain-0": { markers: 0, display: false, reset: false },
  "hidden-64": { markers: 64, display: false, reset: false },
  "reset-64": { markers: 64, display: true, reset: true },
} as const;
type DeltaCase = keyof typeof deltaCases;
const defaultOperations = ["recent", "page", "gateway-tail"] as const;
const operations = [...defaultOperations, "delta"] as const;
type Operation = (typeof operations)[number];
const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    samples: { type: "string", default: "30" },
    output: { type: "string" },
    worker: { type: "string" },
    operation: { type: "string" },
    "delta-case": { type: "string" },
    "delta-cursor": { type: "string" },
    analyze: { type: "boolean" },
    help: { type: "boolean" },
  },
});
const samples = parseStrictIntegerOption({
  fallback: 30,
  label: "--samples",
  min: 1,
  raw: values.samples,
});

function scopeFor(stateDir: string, profile: Profile | DeltaCase) {
  const sessionId = `bench-${profile}`;
  return {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
}

function fixture(profile: Profile): TranscriptEvent[] {
  const spec = profiles[profile];
  const events: TranscriptEvent[] = [{ type: "session", version: 3, id: `bench-${profile}` }];
  let parentId: string | null = null;
  const append = (event: Record<string, unknown> & { id: string }) => {
    events.push({ ...event, parentId, timestamp: "2026-09-01T00:00:00.000Z" });
    parentId = event.id;
  };
  for (let index = 0; index < spec.messages; index += 1) {
    if (spec.reset && index === spec.messages - 1000) {
      append({
        type: "reset",
        id: "reset",
        reason: "new",
        firstKeptEntryId: `message-${index - 2}`,
      });
    }
    append({
      type: "message",
      id: `message-${index}`,
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Synthetic message ${index}: ${"x".repeat(1024)}` }],
      },
    });
    if (spec.markers) {
      append({
        type: "custom_message",
        id: `marker-${index}`,
        customType: "benchmark-notice",
        content: `Synthetic notice ${index}`,
        display: index % 2 === 0,
      });
    }
    if (profile === "sparse" && index % 1000 === 0) {
      append({ type: "compaction", id: `compaction-${index}`, summary: "Synthetic compaction" });
    }
  }
  if (profile === "trailing") {
    for (let index = 0; index < 5000; index += 1) {
      append({ type: "compaction", id: `trailing-${index}`, summary: "Synthetic compaction" });
    }
  }
  return events;
}

function deltaFixture(name: DeltaCase): TranscriptEvent[] {
  const spec = deltaCases[name];
  const events = fixture("small");
  events[0] = { type: "session", version: 3, id: `bench-${name}` };
  let parentId = "message-79";
  const append = (event: Record<string, unknown> & { id: string }) => {
    events.push({ ...event, parentId, timestamp: "2026-09-01T00:00:00.000Z" });
    parentId = event.id;
  };
  if (spec.reset) {
    append({ type: "reset", id: "delta-reset", reason: "new", firstKeptEntryId: "message-78" });
  }
  for (let index = 0; index < spec.markers; index += 1) {
    append({
      type: "custom_message",
      id: `delta-marker-${index}`,
      customType: "benchmark-notice",
      content: `Synthetic notice ${index}`,
      display: spec.display,
    });
  }
  return events;
}

function deltaMessage(index: number) {
  return {
    role: "user",
    content: [{ type: "text", text: `Synthetic delta ${index}: ${"x".repeat(1024)}` }],
  };
}

async function appendDelta(scope: ReturnType<typeof scopeFor>, index: number, parentId: string) {
  const { appendTranscriptMessage } =
    await import("../src/config/sessions/session-accessor.sqlite-transcript-write.js");
  const { waitForSessionTranscriptProjection } =
    await import("../src/config/sessions/session-transcript-reconcile.js");
  const appended = await appendTranscriptMessage(scope, {
    eventId: `delta-sample-${index}`,
    parentId,
    now: Date.parse("2026-09-01T01:00:00.000Z") + index,
    message: deltaMessage(index),
  });
  assert.equal(appended.appended, true);
  assert.equal(appended.messageId, `delta-sample-${index}`);
  assert.equal(appended.effectiveParentId, parentId);
  await waitForSessionTranscriptProjection(scope);
}

function percentile(numbers: number[], percent: number): number {
  const ordered = numbers.toSorted((a, b) => a - b);
  return Number(
    (ordered[Math.max(0, Math.ceil((percent / 100) * ordered.length) - 1)] ?? 0).toFixed(3),
  );
}

type Sample = { wallMs: number; cpuMs: number; heapDeltaBytes: number; rssBytes: number };
async function measure(read: () => Promise<unknown>): Promise<Sample> {
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const start = performance.now();
  await read();
  const wallMs = performance.now() - start;
  const usedCpu = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  return {
    wallMs,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    heapDeltaBytes: after.heapUsed - before.heapUsed,
    rssBytes: after.rss,
  };
}

type QueryTrace = {
  sql: string;
  calls: number;
  rows: number;
  elapsedMs: number;
  bindings: unknown[];
};
async function trace(read: () => Promise<unknown>) {
  const queries = new Map<string, QueryTrace>();
  const originalParse = JSON.parse;
  const originalStringify = JSON.stringify;
  const originalGet = mock.method(StatementSync.prototype, "get");
  const originalAll = mock.method(StatementSync.prototype, "all");
  const originalIterate = mock.method(StatementSync.prototype, "iterate");
  let jsonParseCalls = 0;
  let jsonParseBytes = 0;
  let jsonStringifyCalls = 0;
  const query = (statement: StatementSync, bindings: unknown[]) => {
    const sql = statement.sourceSQL;
    let record = queries.get(sql);
    if (!record) {
      record = { sql, calls: 0, rows: 0, elapsedMs: 0, bindings };
      queries.set(sql, record);
    }
    record.calls += 1;
    return record;
  };
  Object.defineProperty(JSON, "parse", {
    configurable: true,
    writable: true,
    value(...args: unknown[]) {
      jsonParseCalls += 1;
      if (typeof args[0] === "string") {
        jsonParseBytes += Buffer.byteLength(args[0]);
      }
      return Reflect.apply(originalParse, JSON, args);
    },
  });
  Object.defineProperty(JSON, "stringify", {
    configurable: true,
    writable: true,
    value(...args: unknown[]) {
      jsonStringifyCalls += 1;
      return Reflect.apply(originalStringify, JSON, args);
    },
  });
  for (const [name, original] of [
    ["get", originalGet],
    ["all", originalAll],
  ] as const) {
    Object.defineProperty(StatementSync.prototype, name, {
      configurable: true,
      writable: true,
      value(this: StatementSync, ...args: unknown[]) {
        const record = query(this, args);
        const start = performance.now();
        const result: unknown = Reflect.apply(original.bind(this), undefined, args);
        record.elapsedMs += performance.now() - start;
        record.rows += Array.isArray(result) ? result.length : result === undefined ? 0 : 1;
        return result;
      },
    });
  }
  Object.defineProperty(StatementSync.prototype, "iterate", {
    configurable: true,
    writable: true,
    *value(this: StatementSync, ...args: unknown[]) {
      const record = query(this, args);
      const iterator = Reflect.apply(originalIterate.bind(this), undefined, args);
      try {
        while (true) {
          const start = performance.now();
          const next = iterator.next();
          record.elapsedMs += performance.now() - start;
          if (next.done) {
            break;
          }
          record.rows += 1;
          yield next.value;
        }
      } finally {
        iterator.return?.();
      }
    },
  });
  try {
    await read();
  } finally {
    JSON.parse = originalParse;
    JSON.stringify = originalStringify;
    originalGet.mock.restore();
    originalAll.mock.restore();
    originalIterate.mock.restore();
  }
  return { queries: [...queries.values()], jsonParseCalls, jsonParseBytes, jsonStringifyCalls };
}

async function worker(stateDir: string, profile: Profile | DeltaCase, operation: Operation) {
  const scope = scopeFor(stateDir, profile);
  const importStarted = performance.now();
  const history = await import("../src/config/sessions/session-accessor.sqlite-history-events.js");
  const gateway =
    operation === "gateway-tail"
      ? await import("../src/gateway/session-history-tail.js")
      : undefined;
  const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesForTest } =
    await import("../src/state/openclaw-agent-db.js");
  const rawDelta =
    operation === "delta"
      ? await import("../src/config/sessions/session-accessor.sqlite-delta.js")
      : undefined;
  const importMs = performance.now() - importStarted;
  let cursor = values["delta-cursor"];
  let appendIndex = 0;
  const deltaSpec = operation === "delta" ? deltaCases[profile as DeltaCase] : undefined;
  let parentId = deltaSpec?.markers
    ? `delta-marker-${deltaSpec.markers - 1}`
    : deltaSpec?.reset
      ? "delta-reset"
      : "message-79";
  let deltaResult: SessionTranscriptDisplayDeltaResult | undefined;
  const responses: Array<{
    appendIndex: number;
    cursor: string;
    result: SessionTranscriptDisplayDeltaResult;
  }> = [];
  const prepare = async () => {
    if (!deltaSpec) {
      return;
    }
    assert.ok(deltaResult?.kind === "page");
    assert.ok(deltaResult.activeLeafEntryId);
    cursor = deltaResult.cursor;
    parentId = deltaResult.activeLeafEntryId;
    appendIndex += 1;
    await appendDelta(scope, appendIndex, parentId);
  };
  const validate = () => {
    if (!rawDelta) {
      return;
    }
    assert.ok(cursor && deltaResult?.kind === "page");
    const { activeLeafEntryId, events, ...page } = deltaResult;
    assert.equal(activeLeafEntryId, `delta-sample-${appendIndex}`);
    assert.equal(page.hasMore, false);
    assert.deepEqual(
      { ...page, events: events.map(({ seq, event }) => ({ seq, event })) },
      rawDelta.readTranscriptRawDelta(scope, { cursor, maxEvents: 200, maxBytes: 256 * 1024 }),
    );
    const full = history.readSessionTranscriptHistoryEvents(scope);
    const expected = full.at(-1);
    assert.ok(expected);
    assert.deepEqual(events, [
      {
        seq: expected.eventSeq,
        event: expected.event,
        eventSeq: expected.eventSeq,
        messageSeq: expected.seq,
        displayPosition: expected.displayPosition,
      },
    ]);
    assert.deepEqual(expected.event, {
      type: "message",
      id: `delta-sample-${appendIndex}`,
      parentId,
      timestamp: new Date(Date.parse("2026-09-01T01:00:00.000Z") + appendIndex).toISOString(),
      message: deltaMessage(appendIndex),
    });
    assert.notEqual(page.cursor, cursor);
    responses.push({ appendIndex, cursor, result: deltaResult });
  };
  const read = async () => {
    if (deltaSpec) {
      deltaResult = history.readTranscriptDisplayDelta(scope, {
        cursor,
        maxEvents: 200,
        maxBytes: 256 * 1024,
      });
      return deltaResult;
    }
    if (gateway) {
      const result = await gateway.readIncrementalChatHistoryTail({
        entry: undefined,
        readScope: scope,
        effectiveMaxChars: 8000,
        max: 20,
        maxBytes: 256 * 1024,
      });
      assert.ok(result.projected.length >= 20);
      return { returned: result.projected.length, total: result.readPage.totalMessages };
    }
    const result =
      operation === "recent"
        ? history.readRecentSessionTranscriptHistoryEvents(scope, {
            maxMessages: 20,
            maxLines: 20,
            maxBytes: 256 * 1024,
          })
        : history.readSessionTranscriptHistoryEventPage(scope, {
            maxMessages: 20,
            offset: 40,
            maxBytes: 256 * 1024,
          });
    assert.equal(result.events.length, 20);
    return { returned: result.events.length, total: result.totalMessages };
  };
  try {
    // A fresh child has no history/module/statement cache; the OS page cache is not flushed.
    const firstRead = await measure(read);
    validate();
    for (let index = 0; index < 5; index += 1) {
      await prepare();
      await read();
      validate();
    }
    const timings: Sample[] = [];
    for (let index = 0; index < samples; index += 1) {
      await prepare();
      timings.push(await measure(read));
      validate();
    }
    const lastMeasuredResult = deltaResult;
    await prepare();
    const traced = await trace(read);
    validate();
    const database = openOpenClawAgentDatabase({ agentId: "main", env: scope.env });
    const queries = traced.queries.map(({ bindings, ...record }) => {
      const explain = database.db.prepare(`EXPLAIN QUERY PLAN ${record.sql}`);
      return { ...record, plan: Reflect.apply(explain.all.bind(explain), undefined, bindings) };
    });
    console.log(
      JSON.stringify({
        profile,
        operation,
        importMs,
        firstRead,
        warm: {
          samples,
          p50Ms: percentile(
            timings.map((sample) => sample.wallMs),
            50,
          ),
          p95Ms: percentile(
            timings.map((sample) => sample.wallMs),
            95,
          ),
          cpuP50Ms: percentile(
            timings.map((sample) => sample.cpuMs),
            50,
          ),
          cpuP95Ms: percentile(
            timings.map((sample) => sample.cpuMs),
            95,
          ),
          heapDeltaP50Bytes: percentile(
            timings.map((sample) => sample.heapDeltaBytes),
            50,
          ),
          maxRssBytes: Math.max(...timings.map((sample) => sample.rssBytes)),
        },
        result: deltaSpec ? lastMeasuredResult : await read(),
        ...(deltaSpec
          ? {
              delta: {
                ...deltaSpec,
                seedMessages: 80,
                agentId: scope.agentId,
                sessionId: scope.sessionId,
                databasePath: database.path,
                warmSamples: timings.map((sample, index) => ({
                  appendIndex: index + 6,
                  wallMs: sample.wallMs,
                  cpuMs: sample.cpuMs,
                  heapDeltaBytes: sample.heapDeltaBytes,
                  rssBytes: sample.rssBytes,
                })),
                responses,
              },
            }
          : {}),
        trace: { ...traced, queries },
      }),
    );
  } finally {
    closeOpenClawAgentDatabasesForTest(stateDir);
    if (deltaSpec) {
      const { closeOpenClawStateDatabaseForTest } =
        await import("../src/state/openclaw-state-db.js");
      closeOpenClawStateDatabaseForTest();
    }
  }
}

async function main() {
  if (values.help) {
    console.log(
      "Usage: node --import ./scripts/tsx.mjs scripts/bench-session-history.ts [--profile small,long,sparse,markers,reset,trailing] [--operation recent|page|gateway-tail|delta] [--delta-case visible-1,visible-8,visible-64,visible-1024,plain-0,hidden-64,reset-64] [--samples 30] [--analyze] [--output report.json]\nDelta is opt-in and uses --delta-case instead of --profile. Reports a fresh-process first read and warm p50/p95, CPU, RSS, heap deltas, and separate SQL/JSON tracing. Fixtures are synthetic and automatically removed; OS caches are not flushed.",
    );
    return;
  }
  const delta = values.operation === "delta";
  assert.ok(
    delta ? !values.profile : !values["delta-case"] && !values["delta-cursor"],
    "--delta-case/--delta-cursor require delta; --profile selects existing readers only",
  );
  const selected = delta
    ? (values["delta-case"]?.split(",") ?? Object.keys(deltaCases))
    : values.profile
      ? values.profile.split(",")
      : Object.keys(profiles).filter((profile) => profile !== "trailing");
  for (const name of selected) {
    assert.ok(Object.hasOwn(delta ? deltaCases : profiles, name), `Unknown profile/case ${name}`);
  }
  const selectedOperations = values.operation ? [values.operation as Operation] : defaultOperations;
  for (const operation of selectedOperations) {
    assert.ok(operations.includes(operation), `Unknown operation ${operation}`);
  }
  if (values.worker) {
    assert.equal(selected.length, 1);
    assert.ok(delta ? values["delta-cursor"] : values.profile);
    assert.ok(operations.includes(values.operation as Operation));
    await worker(values.worker, selected[0] as Profile | DeltaCase, values.operation as Operation);
    return;
  }
  assert.ok(!values["delta-cursor"], "--delta-cursor is reserved for the prepared child");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-history-benchmark-"));
  const configPath = path.join(stateDir, "openclaw.json");
  fs.writeFileSync(configPath, "{}\n");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  const { replaceTranscriptEvents } =
    await import("../src/config/sessions/session-accessor.sqlite-transcript-write.js");
  const { waitForSessionTranscriptProjection } =
    await import("../src/config/sessions/session-transcript-reconcile.js");
  const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesForTest } =
    await import("../src/state/openclaw-agent-db.js");
  const { closeOpenClawStateDatabaseForTest } = await import("../src/state/openclaw-state-db.js");
  const results: unknown[] = [];
  try {
    for (const name of selected) {
      const profile = name as Profile | DeltaCase;
      await replaceTranscriptEvents(
        scopeFor(stateDir, profile),
        delta ? deltaFixture(name as DeltaCase) : fixture(name as Profile),
      );
      await waitForSessionTranscriptProjection(scopeFor(stateDir, profile));
      if (values.analyze) {
        openOpenClawAgentDatabase({
          agentId: "main",
          env: scopeFor(stateDir, profile).env,
        }).db.exec("ANALYZE");
      }
      closeOpenClawAgentDatabasesForTest(stateDir);
      closeOpenClawStateDatabaseForTest();
      for (const operation of selectedOperations) {
        let initialCursor: string | undefined;
        if (delta) {
          const { readRecentSessionTranscriptHistoryEvents } =
            await import("../src/config/sessions/session-accessor.sqlite-history-events.js");
          const initial = readRecentSessionTranscriptHistoryEvents(scopeFor(stateDir, profile), {
            maxMessages: 0,
            maxLines: 0,
            maxBytes: 8 * 1024 * 1024,
          });
          assert.ok(initial.deltaCursor && initial.activeLeafEntryId);
          initialCursor = initial.deltaCursor;
          await appendDelta(scopeFor(stateDir, profile), 0, initial.activeLeafEntryId);
          closeOpenClawAgentDatabasesForTest(stateDir);
          closeOpenClawStateDatabaseForTest();
        }
        const child = spawnSync(
          process.execPath,
          [
            "--import",
            delta ? fileURLToPath(new URL("./tsx.mjs", import.meta.url)) : "tsx",
            fileURLToPath(import.meta.url),
            "--worker",
            stateDir,
            delta ? "--delta-case" : "--profile",
            profile,
            ...(initialCursor ? ["--delta-cursor", initialCursor] : []),
            "--operation",
            operation,
            "--samples",
            String(samples),
          ],
          { env: process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        );
        if (child.status !== 0) {
          throw new Error(child.stderr || child.stdout || String(child.error));
        }
        const result: unknown = JSON.parse(child.stdout);
        results.push(result);
        console.error(`${profile}/${operation} measured`);
      }
    }
    const report = {
      schemaVersion: 1,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: os.cpus()[0]?.model,
      methodology:
        "Fresh-process first read excludes module import and includes database open. OS caches are not flushed. Warm samples exclude setup and tracing. Heap deltas are uncollected observations, not allocation totals. Trace counts rows delivered to JS, not rows scanned inside SQLite.",
      profiles,
      ...(delta
        ? {
            deltaCases,
            deltaMethodology:
              "Historical marker counts stay fixed; every read follows one untimed ordinary-message append and projection settlement. Parent preparation precedes the fresh child's first read. Full history and raw-delta validation run after timing and may warm caches for subsequent samples, consistently in both arms. Responses retain all first, warmup, sample, and traced results in order; result is the last timed response. Opaque cursor generations and display sources remain raw; they are not cross-process equality claims.",
          }
        : {}),
      analyzed: values.analyze ?? false,
      results,
    };
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output) {
      fs.writeFileSync(path.resolve(values.output), output);
    }
    console.log(output);
  } finally {
    closeOpenClawAgentDatabasesForTest(stateDir);
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

await main();
