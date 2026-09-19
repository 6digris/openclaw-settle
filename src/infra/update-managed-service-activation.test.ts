import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareManagedServiceUpdateHandoffActivation } from "./update-managed-service-activation.js";

const mocks = vi.hoisted(() => ({ meta: vi.fn(), read: vi.fn(), owns: vi.fn() }));
vi.mock("./update-control-plane-sentinel.js", () => ({
  readControlPlaneUpdateSentinelMeta: mocks.meta,
}));
vi.mock("./update-install-root.js", () => ({ resolveUpdateInstallRoot: (root: string) => root }));
vi.mock("./update-managed-service-handoff-lease.js", () => ({
  createManagedHandoffLeaseStore: () => ({ read: mocks.read, owns: mocks.owns }),
}));

const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
const stdout = Object.getOwnPropertyDescriptor(process, "stdout")!;
let input: PassThrough;
let output: PassThrough;
let requests: string;
const assertCurrent = vi.fn();
const onStopped = vi.fn();
const lease = {
  owner: "handoff",
  action: { kind: "update" },
  helper: { pid: 100 },
  executor: { pid: 200 },
};
const params = { root: "/fixture", runId: "run", assertCurrent };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
  input = new PassThrough();
  output = new PassThrough();
  requests = "";
  output.on("data", (chunk) => {
    requests += chunk.toString();
  });
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });
  mocks.meta.mockResolvedValue({ root: params.root, runId: params.runId, handoffId: lease.owner });
  mocks.read.mockReturnValue({ kind: "current", lease });
  mocks.owns.mockReturnValue(true);
});

afterEach(() => {
  Object.defineProperty(process, "stdin", stdin);
  Object.defineProperty(process, "stdout", stdout);
  input.destroy();
  output.destroy();
  vi.unstubAllEnvs();
});

it.each([
  "ordinary caller",
  "different run",
  "different root",
  "missing lease",
  "different owner",
  "triage",
  "self-owned executor",
  "expired lease",
])("does not grant helper activation to %s", async (scenario) => {
  if (scenario === "ordinary caller") {
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
  }
  if (scenario === "different run") {
    mocks.meta.mockResolvedValue({ root: params.root, runId: "other", handoffId: lease.owner });
  }
  if (scenario === "different root") {
    mocks.meta.mockResolvedValue({ root: "/other", runId: params.runId, handoffId: lease.owner });
  }
  if (scenario === "missing lease") {
    mocks.read.mockReturnValue({ kind: "absent" });
  }
  if (scenario === "different owner") {
    mocks.read.mockReturnValue({ kind: "current", lease: { ...lease, owner: "replacement" } });
  }
  if (scenario === "triage") {
    mocks.read.mockReturnValue({
      kind: "current",
      lease: { ...lease, action: { kind: "triage" } },
    });
  }
  if (scenario === "self-owned executor") {
    mocks.read.mockReturnValue({ kind: "current", lease: { ...lease, executor: lease.helper } });
  }
  if (scenario === "expired lease") {
    mocks.owns.mockReturnValue(false);
  }
  expect(await prepareManagedServiceUpdateHandoffActivation(params)).toBeUndefined();
  expect(requests).toBe("");
});

it("waits for a complete parked acknowledgement before recording the stopped service", async () => {
  const activate = await prepareManagedServiceUpdateHandoffActivation(params);
  expect(activate).toBeDefined();
  const pending = activate!(onStopped);
  expect(requests).toBe("park\n");
  input.write("park");
  expect(onStopped).not.toHaveBeenCalled();
  input.write("ed\n");
  await pending;
  expect(onStopped).toHaveBeenCalledOnce();
  expect(input.listenerCount("data")).toBe(0);
  await expect(activate!(onStopped)).rejects.toThrow("already been requested");
  expect(requests).toBe("park\n");
});

it.each(["cancelled\n", "parked\nextra", "x".repeat(64), "eof", "pipe-error"])(
  "does not record a stop on rejected or incomplete reply %j",
  async (reply) => {
    const activate = await prepareManagedServiceUpdateHandoffActivation(params);
    const pending = activate!(onStopped);
    const rejected = expect(pending).rejects.toThrow();
    if (reply === "eof") {
      input.end();
    } else if (reply === "pipe-error") {
      output.emit("error", new Error("pipe closed"));
    } else {
      input.write(reply);
    }
    await rejected;
    expect(onStopped).not.toHaveBeenCalled();
    expect(input.listenerCount("data")).toBe(0);
  },
);

it("rechecks the captured lease before dispatch instead of adopting a replacement", async () => {
  const activate = await prepareManagedServiceUpdateHandoffActivation(params);
  mocks.owns.mockReturnValue(false);
  await expect(activate!(onStopped)).rejects.toThrow("original helper assignment");
  expect(requests).toBe("");
  expect(onStopped).not.toHaveBeenCalled();
});

it("retains the acknowledged stop when the executor loses authority during teardown", async () => {
  const activate = await prepareManagedServiceUpdateHandoffActivation(params);
  const pending = activate!(onStopped);
  const rejected = expect(pending).rejects.toThrow("original helper assignment");
  mocks.owns.mockReturnValue(false);
  input.write("parked\n");
  await rejected;
  expect(onStopped).toHaveBeenCalledOnce();
});

it("contains a failed write callback and its subsequent error event", async () => {
  const broken = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("broken control pipe"));
    },
  });
  Object.defineProperty(process, "stdout", { configurable: true, value: broken });
  const activate = await prepareManagedServiceUpdateHandoffActivation(params);
  await expect(activate!(onStopped)).rejects.toThrow("broken control pipe");
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(onStopped).not.toHaveBeenCalled();
  expect(broken.listenerCount("error")).toBe(0);
  expect(input.listenerCount("data")).toBe(0);
});
