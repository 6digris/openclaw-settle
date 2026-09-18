import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  completeWorkerLaunchDescriptor,
  type WorkerLaunchPlan,
} from "../../worker/launch-descriptor.js";
import { roundTripWorkerLaunchDescriptor } from "../../worker/launch-descriptor.test-support.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  credential,
  measureLaunchTurn,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  seedActivePlacement,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

describe("worker turn execution", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it("withholds approval-bound exec on an actually placed scheduled turn", async () => {
    seedActivePlacement();
    let descriptor: WorkerLaunchPlan | undefined;
    const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async ({ plan }) => {
      descriptor = roundTripWorkerLaunchDescriptor(
        completeWorkerLaunchDescriptor(plan, {
          kind: "unix",
          socketPath: "/tmp/worker-approval.sock",
        }),
      );
      throw new WorkerRunnerCapacityError();
    });
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      launchTurn,
      measureLaunchTurn,
      runWorkspaceCommand: vi.fn(),
      quiesceWorkspace: vi.fn(),
      syncWorkspace: vi.fn(),
      reconcileWorkspace: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    const environments = {
      ...unusedEnvironments(),
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      startTunnel: vi.fn(async () => tunnel),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn();
    await expect(
      provider.executeTurn(
        { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: "run-scheduled" },
        {
          ...turn("run-scheduled"),
          permissionMode: "full",
          execSession: { permissionMode: "full" },
          execOverrides: { host: "gateway", security: "full", ask: "off" },
          toolsAllow: ["exec", "process"],
          scheduledToolPolicy: {
            version: 1,
            mode: "trusted",
            execTarget: { host: "gateway", ask: "always" },
          },
        },
        runLocal,
      ),
    ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
    expect(launchTurn).toHaveBeenCalledOnce();
    expect(runLocal).not.toHaveBeenCalled();
    expect(descriptor?.assignment.toolAuthority).toMatchObject({
      allowedToolNames: [],
      exec: { host: "gateway", security: "full", ask: "always" },
    });
  });

  it.each([undefined, "gateway", "runtime-local"] as const)(
    "dispatches a registered paired-device turn with inference placement %s",
    async (inference) => {
      seedActivePlacement();
      const environment = attachedEnvironment();
      environment.providerId = "device";
      environment.nodeDeviceId = "paired-inference-node";
      environment.sshEndpoint = null;
      environment.profileSnapshot = { settings: inference ? { inference } : {} };
      environment.bootstrapReceipt!.protocolFeatures.push(WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE);
      let descriptor: WorkerLaunchPlan | undefined;
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async ({ plan }) => {
        descriptor = roundTripWorkerLaunchDescriptor(
          completeWorkerLaunchDescriptor(plan, {
            kind: "unix",
            socketPath: "/tmp/worker-local-inference.sock",
          }),
        );
        throw new WorkerRunnerCapacityError();
      });
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        launchTurn,
        measureLaunchTurn,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      };
      const environments = {
        ...unusedEnvironments(),
        get: vi.fn(() => environment),
        acquireTurnCredential: vi.fn(async () => credential()),
        startTunnel: vi.fn(async () => tunnel),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const runLocal = vi.fn();
      const params = turn("run-inference-placement");
      const baseUrl = "https://gateway-inference.example.test/v1";
      const apiKey = ["synthetic", "gateway", "inference", "fixture"].join("-");
      await expect(
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: params.runId,
          },
          {
            ...params,
            config: {
              ...params.config,
              models: {
                providers: { openai: { baseUrl, apiKey, api: "openai-completions", models: [] } },
              },
            },
          },
          runLocal,
        ),
      ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);

      expect(launchTurn).toHaveBeenCalledOnce();
      expect(environments.acquireTurnCredential).toHaveBeenCalledOnce();
      expect(environments.startTunnel).toHaveBeenCalledOnce();
      expect(runLocal).not.toHaveBeenCalled();
      expect(descriptor?.assignment.modelRef).toEqual({ provider: "openai", model: "gpt-test" });
      if (inference === "runtime-local") {
        expect(descriptor?.assignment.inference).toBe("runtime-local");
      } else {
        expect(descriptor?.assignment).not.toHaveProperty("inference");
      }
      expect(descriptor?.assignment).not.toHaveProperty("baseUrl");
      expect(descriptor?.assignment).not.toHaveProperty("apiKey");
      expect(JSON.stringify(descriptor)).not.toContain(baseUrl);
      expect(JSON.stringify(descriptor)).not.toContain(apiKey);
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    },
  );

  it.each(["missing-feature", "missing-node", "model-policy"] as const)(
    "rejects runtime-local %s before credential, tunnel, or dispatch without local fallback",
    async (rejection) => {
      seedActivePlacement();
      const environment = attachedEnvironment();
      environment.providerId = "device";
      environment.nodeDeviceId = rejection === "missing-node" ? null : "paired-inference-node";
      environment.sshEndpoint = null;
      environment.profileSnapshot = { settings: { inference: "runtime-local" } };
      if (rejection !== "missing-feature") {
        environment.bootstrapReceipt!.protocolFeatures.push(
          WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE,
        );
      }
      const environments = {
        ...unusedEnvironments(),
        get: vi.fn(() => environment),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const runLocal = vi.fn();
      const onExecutionPhase = vi.fn();
      const params = turn("run-rejected-local-inference");
      await expect(
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: params.runId,
          },
          {
            ...params,
            ...(rejection === "model-policy"
              ? {
                  config: {
                    ...params.config,
                    agents: {
                      defaults: {
                        ...params.config.agents.defaults,
                        modelPolicy: { allow: ["openai/gpt-approved-only"] },
                      },
                    },
                  },
                }
              : {}),
            onExecutionPhase,
          },
          runLocal,
        ),
      ).rejects.toThrow(
        rejection === "model-policy"
          ? "Model is not approved for this worker agent"
          : "Runtime-local inference requires a matching capable paired-node worker build",
      );
      expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
      expect(environments.startTunnel).not.toHaveBeenCalled();
      expect(onExecutionPhase).not.toHaveBeenCalled();
      expect(runLocal).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    },
  );

  it.each([
    [WORKER_LAUNCH_V2_PROTOCOL_FEATURE],
    [WORKER_LAUNCH_V2_PROTOCOL_FEATURE, WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
  ])(
    "fences a stale worker receipt %j while a current receipt proceeds to execution",
    async (...protocolFeatures) => {
      seedActivePlacement();
      const oldEnvironment = attachedEnvironment();
      const currentReceipt = oldEnvironment.bootstrapReceipt;
      oldEnvironment.bootstrapReceipt = {
        ...currentReceipt!,
        protocolFeatures,
      };
      const passedFence = new Error("current worker receipt passed the turn-execution fence");
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: vi.fn(() => oldEnvironment),
        acquireTurnCredential: vi.fn(async () => {
          throw passedFence;
        }),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

      await expect(
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: "run-old-worker",
          },
          turn("run-old-worker"),
          runLocal,
        ),
      ).rejects.toThrow(
        "Active worker bundle lacks the current launch capability; reprovision the worker before launch",
      );

      expect(runLocal).not.toHaveBeenCalled();
      expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
      expect(environments.startTunnel).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });

      oldEnvironment.bootstrapReceipt = currentReceipt;
      await expect(
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: "run-current-worker",
          },
          turn("run-current-worker"),
          runLocal,
        ),
      ).rejects.toBe(passedFence);

      expect(environments.acquireTurnCredential).toHaveBeenCalledOnce();
      expect(environments.startTunnel).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    },
  );
});
