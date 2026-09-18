import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { runPluginRegisterSyncInRegistry } from "../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { evaluateJudgmentInRegistry, prepareJudgmentProviderReload } from "./runtime.js";
import type { JudgmentBatch, JudgmentProviderV1, ProviderJudgmentOutcome } from "./types.js";
import { validateJudgmentBatch, validateJudgmentResult } from "./validation.js";

const batch: JudgmentBatch = {
  state: { evidence: "synthetic" },
  questions: {
    pick: { type: "choice", criteria: { yes: "supported", unclear: "not established" } },
    rank: { type: "score", criteria: ["low", "middle", "high"] },
    truth: { type: "boolean" },
  },
};
const answer: ProviderJudgmentOutcome = {
  status: "ok",
  result: {
    model: "fixture-v1",
    answers: {
      pick: { type: "choice", choice: "yes", probabilities: { yes: 0.8, unclear: 0.2 } },
      rank: { type: "score", score: 1.3, probabilities: [0.1, 0.5, 0.4] },
      truth: { type: "boolean", probabilityTrue: 0.7 },
    },
    usage: { inputTokens: 25, outputTokens: 4 },
  },
};
const config = { judgments: { provider: "fixture" } };
const options = () => ({
  purpose: "test",
  rubricVersion: "1",
  timeoutMs: 1_000,
  signal: new AbortController().signal,
});
function registered(
  evaluate: JudgmentProviderV1["evaluate"] = async () => answer,
  isReady?: () => boolean,
) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "owner",
    source: "/synthetic/index.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: { judgmentProviders: ["fixture"] },
  });
  const api = builder.createApi(record, { config });
  runPluginRegisterSyncInRegistry(
    (registration) =>
      registration.registerJudgmentProvider({
        id: "fixture",
        contractVersion: 1,
        evaluate,
        isReady,
      }),
    api,
    builder.registry,
    record.id,
  );
  builder.registry.plugins.push(record);
  setActivePluginRegistry(builder.registry);
  onTestFinished(async () => {
    prepareJudgmentProviderReload(builder.registry, new Set([record.id]));
    await getPluginInstance(record)?.dispose();
  });
  const run = (opts = options(), cfg = config) =>
    evaluateJudgmentInRegistry(batch, opts, builder.registry, cfg);
  return { ...builder, record, api, run };
}
afterEach(() => resetPluginRuntimeStateForTest());

describe("registered judgment capability", () => {
  it("leaves off, missing and cold credentials network-free", async () => {
    const call = vi.fn(async () => answer);
    const host = registered(call, () => false);
    expect(await host.run()).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
    expect(await evaluateJudgmentInRegistry(batch, options(), host.registry, {})).toEqual({
      status: "unavailable",
      reason: "disabled",
    });
    expect(await evaluateJudgmentInRegistry(batch, options(), null, config)).toEqual({
      status: "unavailable",
      reason: "not-configured",
    });
    expect(call).not.toHaveBeenCalled();
  });
  it("preserves choice, fractional score, Boolean, usage and local provenance", async () => {
    const host = registered();
    expect(await host.run()).toMatchObject({
      ...answer,
      provenance: { providerId: "fixture", rubricVersion: "1" },
    });
  });
  it("rejects a whole malformed batch and opens the bounded circuit", async () => {
    const call = vi.fn(async (): Promise<ProviderJudgmentOutcome> => ({
      status: "ok",
      result: { model: "fixture", answers: {} },
    }));
    const host = registered(call);
    for (let i = 0; i < 3; i++) {
      expect(await host.run()).toEqual({ status: "unavailable", reason: "invalid-response" });
    }
    expect(await host.run()).toEqual({ status: "unavailable", reason: "circuit-open" });
    expect(call).toHaveBeenCalledTimes(3);
  });
  it("cancels pending body work before native drain and fences old handles", async () => {
    let settled = false;
    const host = registered(async (_batch, { signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      settled = true;
      return answer;
    });
    const pending = host.run();
    prepareJudgmentProviderReload(host.registry, new Set([host.record.id]));
    expect(await pending).toEqual({ status: "unavailable", reason: "retiring" });
    expect(settled).toBe(true);
    expect(await getPluginInstance(host.record)?.drain()).toEqual({ errors: [] });
    expect(await host.run()).toEqual({ status: "unavailable", reason: "retiring" });
  });
  it("propagates caller cancellation without fallback classification", async () => {
    const caller = new AbortController();
    const host = registered(async (_batch, { signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return answer;
    });
    const pending = host.run({ ...options(), signal: caller.signal });
    caller.abort(new Error("source replaced"));
    await expect(pending).rejects.toThrow("source replaced");
  });
  it.each([
    { consumerId: "owner", changed: ["owner"], consumerRetired: true },
    { consumerId: "consumer", changed: ["owner", "consumer"], consumerRetired: true },
    { consumerId: "consumer", changed: ["owner"], consumerRetired: false },
  ])(
    "preserves consumer retirement when $consumerId calls a replaced provider ($changed)",
    async ({ consumerId, changed, consumerRetired }) => {
      let settled = false;
      const host = registered(async (_batch, { signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        settled = true;
        signal.throwIfAborted();
        return answer;
      });
      const pending = evaluateJudgmentInRegistry(
        batch,
        options(),
        host.registry,
        config,
        consumerId,
      );
      prepareJudgmentProviderReload(host.registry, new Set(changed));
      if (consumerRetired) {
        await expect(pending).rejects.toThrow("Judgment consumer authority closed.");
      } else {
        expect(await pending).toEqual({ status: "unavailable", reason: "retiring" });
      }
      expect(settled).toBe(true);
    },
  );
  it("closes provider admission before notifying retiring consumers", async () => {
    let reentered: ReturnType<typeof evaluateJudgmentInRegistry> | undefined;
    let calls = 0;
    const host = registered(async (_batch, { signal }) => {
      calls++;
      if (calls > 1) {
        return answer;
      }
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            reentered = host.run();
            resolve();
          },
          { once: true },
        );
      });
      signal.throwIfAborted();
      return answer;
    });
    const pending = evaluateJudgmentInRegistry(batch, options(), host.registry, config, "owner");
    prepareJudgmentProviderReload(host.registry, new Set(["owner"]));
    await expect(pending).rejects.toThrow("Judgment consumer authority closed.");
    expect(await reentered).toMatchObject({ status: "unavailable", reason: "retiring" });
    expect(calls).toBe(1);
  });
  it("admits no waiting queue when saturated and settles permits on abort", async () => {
    const host = registered(async (_batch, { signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return answer;
    });
    const requests = Array.from({ length: 4 }, () => host.run());
    expect(await host.run()).toEqual({ status: "unavailable", reason: "overloaded" });
    prepareJudgmentProviderReload(host.registry, new Set([host.record.id]));
    await Promise.all(requests);
    expect(host.registry.judgmentProviders[0]?.host.inspect(config).activeRequests).toBe(0);
  });
  it("distinguishes caller defects from resource limits without network", async () => {
    const call = vi.fn(async () => answer);
    const host = registered(call);
    await expect(
      evaluateJudgmentInRegistry({ state: "", questions: {} }, options(), host.registry, config),
    ).rejects.toThrow("Invalid judgment contract");
    expect(
      await evaluateJudgmentInRegistry(
        { ...batch, state: "x".repeat(1_048_577) },
        options(),
        host.registry,
        config,
      ),
    ).toEqual({ status: "unavailable", reason: "unsupported-input" });
    expect(call).not.toHaveBeenCalled();
  });
  it("never hides a programmer exception as an outage", async () => {
    const host = registered(async () => {
      throw new Error("sensitive provider implementation detail");
    });
    await expect(host.run()).rejects.toThrow("Invalid judgment contract");
  });
});

describe("numerical contract", () => {
  it("accepts only exact answer IDs and ordered expected position", () => {
    expect(validateJudgmentBatch(batch)).toBe(true);
    if (answer.status !== "ok") {
      throw new Error("fixture");
    }
    expect(validateJudgmentResult(batch, answer.result)).toBe(true);
    expect(
      validateJudgmentResult(batch, {
        ...answer.result,
        answers: { ...answer.result.answers, extra: { type: "boolean", probabilityTrue: 1 } },
      }),
    ).toBe(false);
    expect(
      validateJudgmentResult(batch, {
        ...answer.result,
        answers: {
          ...answer.result.answers,
          rank: { type: "score", score: 2, probabilities: [0.1, 0.5, 0.4] },
        },
      }),
    ).toBe(false);
  });
});

describe("fault settlement and generation health", () => {
  it("joins a deadline-aborted callback and records no success", async () => {
    let settled = false;
    const host = registered(async (_batch, { signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      settled = true;
      return answer;
    });
    expect(await host.run({ ...options(), timeoutMs: 10 })).toEqual({
      status: "unavailable",
      reason: "deadline",
    });
    expect(settled).toBe(true);
    expect(host.registry.judgmentProviders[0]!.host.inspect(config)).toMatchObject({
      activeRequests: 0,
      successCount: 0,
      reasons: { deadline: 1 },
    });
  });
  it("latches auth errors only in the current configuration generation", async () => {
    const callback = vi
      .fn<JudgmentProviderV1["evaluate"]>()
      .mockResolvedValueOnce({ status: "unavailable", reason: "authentication" })
      .mockResolvedValue(answer);
    const host = registered(callback);
    expect(await host.run()).toMatchObject({ reason: "authentication" });
    expect(await host.run()).toMatchObject({ reason: "circuit-open" });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(await host.run(options(), { judgments: { provider: "fixture" } })).toMatchObject({
      status: "ok",
    });
  });
  it("bounds recovery to one half-open trial", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    let finish!: () => void;
    const callback = vi
      .fn<JudgmentProviderV1["evaluate"]>()
      .mockResolvedValue({ status: "unavailable", reason: "transport" });
    const host = registered(callback);
    try {
      for (let i = 0; i < 3; i++) {
        await host.run();
      }
      now = 10_001;
      callback.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return answer;
      });
      const trial = host.run();
      const duringTrial = host.registry.judgmentProviders[0]!.host.inspect(config);
      expect(await host.run()).toMatchObject({ reason: "circuit-open" });
      finish();
      expect(await trial).toMatchObject({ status: "ok" });
      expect(duringTrial).toMatchObject({ callable: false, activeRequests: 1 });
      expect(host.registry.judgmentProviders[0]!.host.inspect(config).callable).toBe(true);
      expect(callback).toHaveBeenCalledTimes(4);
    } finally {
      clock.mockRestore();
    }
  });
  it("rejects executable JSON without executing a getter and sanitizes readiness defects", async () => {
    const getter = vi.fn(() => {
      throw new Error("private detail");
    });
    const state = Object.defineProperty({}, "field", { get: getter, enumerable: true });
    expect(() => validateJudgmentBatch({ ...batch, state })).toThrow("Invalid judgment contract");
    expect(getter).not.toHaveBeenCalled();
    const host = registered(undefined, () => {
      throw new Error("private readiness detail");
    });
    await expect(host.run()).rejects.toThrow("Invalid judgment contract");
  });
});

describe("immutable finite JSON boundaries", () => {
  it("rejects sparse rubrics and symbol-valued fields before dispatch", () => {
    const sparse: string[] = [];
    sparse.length = 2;
    expect(() =>
      validateJudgmentBatch({ state: null, questions: { q: { type: "score", criteria: sparse } } }),
    ).toThrow("Invalid judgment contract");
    const state = Object.assign({}, { [Symbol("unsupported")]: "hidden" });
    expect(() => validateJudgmentBatch({ ...batch, state })).toThrow("Invalid judgment contract");
  });
  it("uses an admitted snapshot even if caller or provider mutates its input", async () => {
    let finish!: () => void;
    const host = registered(async (input) => {
      Reflect.deleteProperty(input.questions, "pick");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return answer;
    });
    const submitted = structuredClone(batch);
    const pending = evaluateJudgmentInRegistry(submitted, options(), host.registry, config);
    Reflect.deleteProperty(submitted.questions, "rank");
    finish();
    expect(await pending).toMatchObject({ status: "ok" });
  });
  it("sanitizes a provider's executable outcome envelope", async () => {
    const host = registered(async () =>
      Object.defineProperty(structuredClone(answer), "status", {
        get() {
          throw new Error("private response detail");
        },
      }),
    );
    await expect(host.run()).rejects.toThrow("Invalid judgment contract");
  });
});

it("leaves a timed-out rollback fenced after late physical settlement", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const host = registered(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return answer;
  });
  const pending = host.run();
  try {
    const replacement = prepareJudgmentProviderReload(host.registry, new Set([host.record.id]));
    const rollback = replacement.rollback(new AbortController().signal);
    const rejected = expect(rollback).rejects.toThrow("plugin host cleanup timed out");
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(await host.run()).toMatchObject({ reason: "retiring" });
    release();
    expect(await pending).toMatchObject({ reason: "retiring" });
    expect(await host.run()).toMatchObject({ reason: "retiring" });
    expect(host.registry.judgmentProviders[0]!.host.inspect(config).activeRequests).toBe(0);
  } finally {
    release();
    await pending;
    vi.useRealTimers();
  }
});

it.each(["stop", "superseded", "canceled"] as const)(
  "does not reopen rollback after %s",
  async (boundary) => {
    const host = registered();
    const replacement = prepareJudgmentProviderReload(host.registry, new Set([host.record.id]));
    const signal = new AbortController();
    if (boundary === "stop") {
      await host.registry.judgmentProviders[0]!.host.stop();
    } else if (boundary === "superseded") {
      prepareJudgmentProviderReload(host.registry, new Set([host.record.id]));
    } else {
      signal.abort(new Error("recovery canceled"));
    }
    await expect(replacement.rollback(signal.signal)).rejects.toThrow();
    expect(await host.run()).toMatchObject({ reason: "retiring" });
  },
);

it("preserves an authentication latch across reversible admission recovery", async () => {
  const call = vi.fn<JudgmentProviderV1["evaluate"]>(async () => ({
    status: "unavailable",
    reason: "authentication",
  }));
  const host = registered(call);
  expect(await host.run()).toMatchObject({ reason: "authentication" });
  const replacement = prepareJudgmentProviderReload(host.registry, new Set([host.record.id]));
  await replacement.rollback(new AbortController().signal);
  expect(await host.run()).toMatchObject({ reason: "circuit-open" });
  expect(call).toHaveBeenCalledTimes(1);
});
