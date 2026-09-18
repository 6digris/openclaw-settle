import { createHook } from "node:async_hooks";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { CodexServerNotification } from "./protocol.js";
import { createClientHarness } from "./test-support.js";

const clients: CodexAppServerClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  vi.restoreAllMocks();
});

it("delivers large notifications to synchronous observers without scheduling promise work", () => {
  const harness = createClientHarness();
  clients.push(harness.client);
  const notification = {
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      delta: "output\n".repeat(50_000),
    },
  };
  const wire = JSON.stringify(notification) + "\n";
  const received: CodexServerNotification[] = [];
  harness.client.addNotificationHandler((value) => {
    received.push(value);
  });
  harness.client.addNotificationHandler((value) => {
    received.push(value);
  });
  let promises = 0;
  const hook = createHook({
    init(_id, type) {
      if (type === "PROMISE") {
        promises++;
      }
    },
  });
  hook.enable();
  try {
    harness.process.stdout.write(wire);
  } finally {
    hook.disable();
  }
  expect(received).toEqual([notification, notification]);
  expect(received[0]?.params).toBe(received[1]?.params);
  expect(promises).toBe(0);
});

it("isolates rejected async observers while delivering subsequent notifications", async () => {
  const harness = createClientHarness();
  clients.push(harness.client);
  const error = new Error("observer failed");
  const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
  harness.client.addNotificationHandler(async () => {
    throw error;
  });
  const received = vi.fn();
  harness.client.addNotificationHandler(received);
  harness.send({ method: "account/updated" });
  harness.send({ method: "account/updated" });
  await Promise.resolve();
  expect(received).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith("codex app-server notification handler failed", { error });
});

it("does not reparse accumulated output for plain unterminated string fragments", () => {
  const harness = createClientHarness();
  clients.push(harness.client);
  const parts = Array.from({ length: 64 }, (_, index) => `fragment-${index}:` + "x".repeat(4096));
  const received = vi.fn();
  harness.client.addNotificationHandler(received);
  const parse = vi.spyOn(JSON, "parse");
  harness.process.stdout.write(
    '{"method":"item/commandExecution/outputDelta","params":{"delta":"' +
      parts.join("\n") +
      '"}}\n',
  );
  expect(received).toHaveBeenCalledExactlyOnceWith({
    method: "item/commandExecution/outputDelta",
    params: { delta: parts.join("\n") },
  });
  expect(parse.mock.calls.length).toBeLessThanOrEqual(2);
});

it.each([
  ["escaped quotes and slashes", 'quoted \\"value\\" and \\\\ slash', true],
  ["invalid escape", "invalid \\q", false],
  ["raw control character", "invalid \t tab", false],
] as const)("preserves parsing and recovery for %s in a continuation", (_name, middle, valid) => {
  const harness = createClientHarness();
  clients.push(harness.client);
  const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
  const received = vi.fn();
  harness.client.addNotificationHandler(received);
  const first = '{"method":"fixture/output","params":{"delta":"first';
  harness.process.stdout.write(first + "\n" + middle + (valid ? '\nlast"}}\n' : "\n"));
  harness.send({ method: "fixture/next" });
  if (valid) {
    expect(received).toHaveBeenNthCalledWith(1, JSON.parse(first + "\\n" + middle + '\\nlast"}}'));
    expect(warn).not.toHaveBeenCalled();
  } else {
    expect(warn).toHaveBeenCalledTimes(1);
  }
  expect(received).toHaveBeenLastCalledWith({ method: "fixture/next", params: undefined });
  expect(received).toHaveBeenCalledTimes(valid ? 2 : 1);
});

it.each([
  ["size", () => Array<string>(4).fill("x".repeat(2 * 1024 * 1024))],
  ["line count", () => Array<string>(1_000).fill("x")],
] as const)("keeps the existing recovery %s limit for plain fragments", (_kind, fragments) => {
  const harness = createClientHarness();
  clients.push(harness.client);
  const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
  const received = vi.fn();
  harness.client.addNotificationHandler(received);
  harness.process.stdout.write(
    '{"method":"fixture/output","params":{"delta":"first\n' + fragments().join("\n") + "\n",
  );
  harness.send({ method: "fixture/next" });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(received).toHaveBeenCalledExactlyOnceWith({ method: "fixture/next", params: undefined });
});
