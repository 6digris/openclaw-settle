// Run from the repo root with Node:
// node --expose-gc --import ./scripts/tsx.mjs extensions/codex/src/app-server/client-line-cost.bench.ts
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { observeCodexCatalogClient } from "../session-catalog-events.js";
import { projectCodexCatalogNativeThread } from "../session-catalog-native-projection.js";
import { CodexAppServerClient } from "./client.js";
import { itemOutputText, itemToolResult } from "./event-projector-tool-items.js";
import { ToolOutputAccumulator } from "./event-projector-tool-output.js";
import { readCodexTurnCompletedNotification } from "./protocol-validators.js";
import { isJsonObject, type CodexThreadItem } from "./protocol.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

function collectGarbage() {
  if (!global.gc) {
    throw new Error("Run with --expose-gc to measure settled heap retention");
  }
  global.gc();
}
const output = "synthetic output ".repeat(16_384);

function fixture(fragmented: boolean) {
  const frames: string[] = [];
  let lines = 0;
  for (let index = 0; index < 10_000; index++) {
    const large = index % 500 === 0;
    const threadId = `thread-${Math.floor(index / 500) % 10}`;
    const message = JSON.stringify({
      method: large
        ? "item/commandExecution/outputDelta"
        : index % 10 === 0
          ? "thread/status/changed"
          : "item/agentMessage/delta",
      params: {
        threadId,
        turnId: "turn",
        itemId: "item",
        ...(index % 10 === 0 && !large
          ? { status: { type: "active", activeFlags: [] } }
          : { delta: large ? output : `delta ${index}` }),
      },
    });
    const fragment = "synthetic output ".repeat(256);
    const wire = fragmented && large ? message.replaceAll(fragment, fragment + "\n") : message;
    lines += wire.split("\n").length;
    frames.push(wire + "\n");
  }
  const wire = Buffer.from(frames.join(""));
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < wire.length; offset += 64 * 1024) {
    chunks.push(wire.subarray(offset, offset + 64 * 1024));
  }
  return { chunks, lines, bytes: wire.length };
}

async function measure(input: ReturnType<typeof fixture>, consumers: boolean) {
  const stdout = new PassThrough();
  const transport = Object.assign(new EventEmitter(), {
    stdout,
    stdin: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: 0,
  });
  const client = CodexAppServerClient.fromTransportForTests(transport);
  let received = 0;
  client.addNotificationHandler(() => {
    received++;
  });
  const routes = [];
  const accumulator = new ToolOutputAccumulator();
  if (consumers) {
    await observeCodexCatalogClient(client, {
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: ["app-server"],
        url: "wss://bench.example.test",
        headers: {},
      },
    });
    const router = getCodexAppServerTurnRouter(client);
    for (let index = 0; index < 10; index++) {
      const route = router.reserveThread({
        threadId: `thread-${index}`,
        onNotification(notification) {
          const params = notification.params;
          if (
            notification.method === "item/commandExecution/outputDelta" &&
            isJsonObject(params) &&
            typeof params.delta === "string" &&
            typeof params.itemId === "string"
          ) {
            accumulator.append(`${index}:${params.itemId}`, params.delta);
          }
        },
      });
      route.armTurn();
      await route.bindTurn("turn");
      routes.push(route);
    }
  } else {
    client.addNotificationHandler(() => {});
    client.addNotificationHandler(() => {});
  }
  try {
    await nextTurn();
    collectGarbage();
    const before = process.memoryUsage().heapUsed;
    const startCpu = process.threadCpuUsage();
    const start = performance.now();
    for (const chunk of input.chunks) {
      stdout.write(chunk);
    }
    await Promise.all(routes.map((route) => route.drain()));
    const wallMs = performance.now() - start;
    const cpu = process.threadCpuUsage(startCpu);
    const mainThreadMs = (cpu.user + cpu.system) / 1_000;
    await nextTurn();
    collectGarbage();
    const retainedHeapBytes = process.memoryUsage().heapUsed - before;
    if (received !== 10_000) {
      throw new Error(`Dropped notifications: ${received}`);
    }
    return {
      wallMs,
      mainThreadMs,
      msPer1kLines: (mainThreadMs * 1_000) / input.lines,
      msPerMB: (mainThreadMs * 1_000_000) / input.bytes,
      retainedHeapBytes,
      retainedOutputCharacters: [...accumulator.textByItem.values()].reduce(
        (sum, text) => sum + text.length,
        0,
      ),
    };
  } finally {
    for (const route of routes) {
      route.release();
    }
    client.close();
  }
}

function measureConsumer(kind: string, bytes: number, consume: () => unknown) {
  for (let index = 0; index < 5; index++) {
    consume();
  }
  const start = process.threadCpuUsage();
  for (let index = 0; index < 100; index++) {
    consume();
  }
  const cpu = process.threadCpuUsage(start);
  const mainThreadMs = (cpu.user + cpu.system) / 1_000;
  return {
    kind,
    iterations: 100,
    mainThreadMs,
    msPer1k: mainThreadMs * 10,
    msPerMB: (mainThreadMs * 1_000_000) / (100 * bytes),
  };
}

function measureConsumers() {
  const accumulator = new ToolOutputAccumulator();
  const command: CodexThreadItem = {
    id: "item",
    type: "commandExecution",
    title: null,
    name: null,
    tool: null,
    server: null,
    command: "printf output",
    cwd: "/workspace",
    query: null,
    text: "",
    changes: [],
    status: "completed",
    aggregatedOutput: output,
    exitCode: 0,
    durationMs: 1,
  };
  const mcp: CodexThreadItem = {
    ...command,
    type: "mcpToolCall",
    command: null,
    cwd: null,
    aggregatedOutput: null,
    tool: "synthetic_tool",
    server: "synthetic_server",
    result: { content: [{ type: "text", text: output }] },
    durationMs: 1,
  };
  const turn = {
    threadId: "thread",
    turn: { id: "turn", status: "completed", items: [], error: null },
  };
  if (!readCodexTurnCompletedNotification(turn)) {
    throw new Error("Invalid terminal fixture");
  }
  return [
    measureConsumer("command output delta accumulator", output.length, () =>
      accumulator.append("item", output),
    ),
    measureConsumer("completed command metadata + transcript", output.length, () => [
      itemToolResult(command),
      itemOutputText(command),
    ]),
    measureConsumer("completed MCP redaction + transcript", output.length, () => [
      itemToolResult(mcp),
      itemOutputText(mcp),
    ]),
    measureConsumer("turn completed validation (empty summary)", JSON.stringify(turn).length, () =>
      readCodexTurnCompletedNotification(turn),
    ),
    measureConsumer("catalog native preview projection", output.length, () =>
      projectCodexCatalogNativeThread({ id: "thread", preview: output }, sanitizeTerminalText),
    ),
  ];
}

console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    description:
      "Synthetic 10000-notification stream, 20 large outputs, 10 threads, 64 KiB pipe chunks. Main-thread CPU includes readline, parse, dispatch, and drained promise work. Consumer mode adds the real router, catalog filter, and tool-output accumulator; it is not a full Gateway/transcript benchmark. Retention is a noisy post-GC heap delta while clients stay open; fixtures predate measurement.",
  }),
);
for (const consumers of [false, true]) {
  for (const fragmented of [false, true]) {
    const input = fixture(fragmented);
    await measure(input, consumers);
    const runs = [];
    for (let index = 0; index < 7; index++) {
      runs.push(await measure(input, consumers));
    }
    console.log(
      JSON.stringify({ consumers, fragmented, lines: input.lines, bytes: input.bytes, runs }),
    );
  }
}
console.log(JSON.stringify({ postParseConsumers: measureConsumers() }));
