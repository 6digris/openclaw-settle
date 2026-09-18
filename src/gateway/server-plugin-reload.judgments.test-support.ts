import { expect } from "vitest";
import { evaluateJudgmentInRegistry } from "../judgments/runtime.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { createPluginReloadRecoveryFixture } from "./server-plugin-reload.recovery.test-support.js";

export async function verifyJudgmentSelectorRetirement(
  createRecoveryFixture: (
    options: Parameters<typeof createPluginReloadRecoveryFixture>[1],
  ) => ReturnType<typeof createPluginReloadRecoveryFixture>,
) {
  const entered = createDeferredCore();
  let callbackSignal: AbortSignal | undefined;
  let settled = false;
  const fixture = await createRecoveryFixture({
    config: { judgments: { provider: "selector-probe" } },
    abortOnCandidateStart: false,
    register(api, owner, record) {
      if (owner !== "first") {
        return;
      }
      record.contracts = { judgmentProviders: ["selector-probe"] };
      api.registerJudgmentProvider({
        id: "selector-probe",
        contractVersion: 1,
        async evaluate(_batch, { signal }) {
          callbackSignal = signal;
          entered.resolve();
          try {
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            signal.throwIfAborted();
            throw new Error("unreachable");
          } finally {
            settled = true;
          }
        },
      });
    },
  });
  const previous = fixture.previousRegistry.plugins.find((record) => record.id === "first")!;
  const pending = evaluateJudgmentInRegistry(
    { state: {}, questions: { check: { type: "boolean", instructions: "Synthetic probe" } } },
    {
      purpose: "test.selector",
      rubricVersion: "fixture-v1",
      timeoutMs: 5000,
      signal: new AbortController().signal,
    },
    fixture.previousRegistry,
    fixture.getConfig(),
  );
  await entered.promise;
  fixture.runtime.runtimeState.gatewayLifetimeSidecars.publish({
    stop: async () => {},
    preparePluginReload: () => {
      // This callback runs before the existing sidecar/memory drain stage.
      expect(callbackSignal?.aborted).toBe(true);
      return {
        drain: async () => {
          await pending;
          expect(settled).toBe(true);
        },
        resume() {},
      };
    },
  });
  const next = { ...fixture.getConfig(), judgments: undefined };
  await fixture.reload(next, [], ["judgments.provider"]);
  expect(await pending).toMatchObject({ status: "unavailable", reason: "retiring" });
  expect(settled).toBe(true);
  expect(() => getPluginInstance(previous)?.run(() => "stale")).toThrow("reloaded or disabled");
  expect(fixture.registryOwner.registry.plugins.find((record) => record.id === "first")).not.toBe(
    previous,
  );
  expect(fixture.siblingStop).not.toHaveBeenCalled();
}

export async function verifyJudgmentEarlyReloadRecovery(
  createRecoveryFixture: (
    options: Parameters<typeof createPluginReloadRecoveryFixture>[1],
  ) => ReturnType<typeof createPluginReloadRecoveryFixture>,
  boundary: "prepare" | "drain" | "discovery",
) {
  const entered = createDeferredCore();
  let callbackSignal: AbortSignal | undefined;
  let settled = false;
  const failure = new Error(`synthetic ${boundary} failure`);
  const fixture = await createRecoveryFixture({
    config: { judgments: { provider: "recovery-probe" } },
    abortOnCandidateStart: false,
    register(api, owner, record) {
      if (owner !== "first") {
        return;
      }
      record.contracts = { judgmentProviders: ["recovery-probe"] };
      api.registerJudgmentProvider({
        id: "recovery-probe",
        contractVersion: 1,
        async evaluate(batch, { signal }) {
          if (batch.state === "hang") {
            callbackSignal = signal;
            entered.resolve();
            try {
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
              });
              signal.throwIfAborted();
            } finally {
              settled = true;
            }
          }
          return {
            status: "ok",
            result: {
              model: "synthetic",
              answers: { check: { type: "boolean", probabilityTrue: 1 } },
            },
          };
        },
      });
    },
  });
  const run = (state: string) =>
    evaluateJudgmentInRegistry(
      { state, questions: { check: { type: "boolean" } } },
      {
        purpose: "test.recovery",
        rubricVersion: "fixture-v1",
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      fixture.registryOwner.registry,
      fixture.getConfig(),
    );
  const initial = await run("ready");
  const pending = run("hang");
  await entered.promise;
  let failed = false;
  const failOnce = () => {
    expect(callbackSignal?.aborted).toBe(true);
    if (!failed) {
      failed = true;
      throw failure;
    }
  };
  fixture.runtime.runtimeState.gatewayLifetimeSidecars.publish({
    stop: async () => {},
    preparePluginReload: () => {
      if (boundary === "prepare") {
        failOnce();
      }
      return {
        drain: async () => {
          if (boundary === "drain") {
            failOnce();
          }
        },
        resume() {},
      };
    },
  });
  if (boundary === "discovery") {
    fixture.runtime.runtimeState.discovery = {
      stop: async () => {},
      update: async () => {
        failOnce();
      },
    };
  }
  await expect(fixture.reload()).rejects.toThrow(`synthetic ${boundary} failure`);
  expect(await pending).toMatchObject({ status: "unavailable", reason: "retiring" });
  expect(settled).toBe(true);
  const recovered = await run("ready");
  expect(recovered).toMatchObject({ status: "ok" });
  if (initial.status === "ok" && recovered.status === "ok") {
    expect(recovered.provenance.runtimeGeneration).not.toBe(initial.provenance.runtimeGeneration);
  }
  expect(
    fixture.registryOwner.registry.judgmentProviders[0]!.host.inspect(fixture.getConfig()),
  ).toMatchObject({ callable: true, activeRequests: 0 });
  expect(fixture.firstStop).not.toHaveBeenCalled();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
}
