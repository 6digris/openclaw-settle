import { randomUUID } from "node:crypto";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginRecord, PluginRegistry } from "../plugins/registry-types.js";
import { getActiveSecretsRuntimeSnapshotRevisionState } from "../secrets/runtime-state.js";
import type {
  JudgmentBatch,
  JudgmentOutcome,
  JudgmentProviderV1,
  JudgmentRuntimeV1,
  ProviderFailureReason,
  UnavailableReason,
} from "./types.js";
import { JudgmentContractError, validateJudgmentResult } from "./validation.js";

type Options = Parameters<JudgmentRuntimeV1["evaluate"]>[1];
const FAILURE_REASONS = new Set<ProviderFailureReason>([
  "credentials-unavailable",
  "authentication",
  "rate-limited",
  "transport",
  "unsupported-input",
  "invalid-response",
]);
const MAX_CONCURRENT = 4;
const COOLDOWN_MS = 10_000;
const MAX_RETRY_AFTER_MS = 60_000;

class JudgmentConsumerClosedError extends Error {
  constructor() {
    super("Judgment consumer authority closed.");
  }
}

type Health = {
  id: string;
  secretRevision: number;
  config: OpenClawConfig["plugins"];
  selection: OpenClawConfig["judgments"];
  failures: number;
  openUntil: number;
  authFailed: boolean;
  trial: boolean;
  lastSuccessAt?: number;
};

/** Instance-owned admission and health. No callback escapes its native owner. */
export class JudgmentProviderHost {
  private retired = false;
  private reloadPause?: object;
  private health?: Health;
  private readonly pending = new Map<
    AbortController,
    { consumerId?: string; done: Promise<void> }
  >();
  private readonly reasons: Partial<Record<UnavailableReason, number>> = {};
  private readonly consumerOutcomes = { accepted: 0, fallback: 0, "no-change": 0 };
  private successCount = 0;
  private totalLatencyMs = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(
    readonly provider: JudgmentProviderV1,
    readonly record: PluginRecord,
  ) {}

  private generation(config: OpenClawConfig): Health {
    const secretRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    if (
      !this.health ||
      this.health.secretRevision !== secretRevision ||
      this.health.config !== config.plugins ||
      this.health.selection !== config.judgments
    ) {
      this.health = {
        id: randomUUID(),
        secretRevision,
        config: config.plugins,
        selection: config.judgments,
        failures: 0,
        openUntil: 0,
        authFailed: false,
        trial: false,
      };
    }
    return this.health;
  }

  recordOutcome(outcome: "accepted" | "fallback" | "no-change"): void {
    if (!Object.hasOwn(this.consumerOutcomes, outcome)) {
      throw new JudgmentContractError();
    }
    if (!this.retired && !this.reloadPause) {
      this.consumerOutcomes[outcome]++;
    }
  }

  unavailable(reason: UnavailableReason): JudgmentOutcome {
    this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
    return { status: "unavailable", reason };
  }

  /** Close only capability admission before reversible native reload preparation. */
  pauseForReload(changedConsumerIds: ReadonlySet<string> = new Set()) {
    const token = {};
    this.reloadPause = token;
    for (const [controller, request] of this.pending) {
      // Close admission before abort callbacks can reenter. A retiring consumer
      // must reject rather than receive the provider-only fallback classification.
      controller.abort(
        request.consumerId !== undefined && changedConsumerIds.has(request.consumerId)
          ? new JudgmentConsumerClosedError()
          : "judgment-provider-retired",
      );
    }
    const assertResumable = () => {
      const instance = getPluginInstance(this.record);
      if (
        this.reloadPause !== token ||
        this.retired ||
        this.pending.size > 0 ||
        !instance?.acceptingCalls ||
        instance.owner?.revoked ||
        instance.lifecycle.signal.aborted
      ) {
        throw new Error("Judgment reload admission cannot safely resume.");
      }
    };
    return {
      settled: Promise.all([...this.pending.values()].map((request) => request.done)),
      assertResumable,
      resume: () => {
        assertResumable();
        // Preserve circuit policy, but never reuse the canceled request generation.
        if (this.health) {
          this.health = { ...this.health, id: randomUUID(), trial: false };
        }
        this.reloadPause = undefined;
      },
    };
  }

  /** Native service stop/disposal is irreversible; rollback must not reopen it. */
  retire(): void {
    this.retired = true;
    for (const controller of this.pending.keys()) {
      controller.abort("judgment-provider-retired");
    }
  }

  cancelConsumer(pluginId: string): void {
    for (const [controller, request] of this.pending) {
      if (request.consumerId === pluginId) {
        controller.abort(new JudgmentConsumerClosedError());
      }
    }
  }

  async stop(): Promise<void> {
    this.retire();
    await Promise.all([...this.pending.values()].map((request) => request.done));
  }

  private ready(): boolean {
    try {
      const available = this.provider.isReady?.() ?? true;
      if (typeof available !== "boolean") {
        throw new JudgmentContractError();
      }
      return available;
    } catch {
      throw new JudgmentContractError();
    }
  }

  inspect(config: OpenClawConfig) {
    const health = this.generation(config);
    const instance = getPluginInstance(this.record);
    const configured = config.judgments?.provider === this.provider.id;
    const enabled =
      config.plugins?.enabled !== false &&
      config.plugins?.entries?.[this.record.id]?.enabled !== false;
    const admitted = !this.retired && !this.reloadPause && instance?.acceptingCalls === true;
    const credentialReady = admitted && instance.run(() => this.ready());
    return {
      providerId: this.provider.id,
      pluginId: this.record.id,
      configured,
      credentialReady,
      callable:
        configured &&
        enabled &&
        credentialReady &&
        !health.authFailed &&
        !health.trial &&
        health.openUntil <= performance.now() &&
        this.pending.size < MAX_CONCURRENT,
      runtimeGeneration: health.id,
      recentSuccessAt: health.lastSuccessAt,
      activeRequests: this.pending.size,
      successCount: this.successCount,
      consumerOutcomes: { ...this.consumerOutcomes },
      totalLatencyMs: this.totalLatencyMs,
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      reasons: { ...this.reasons },
    };
  }

  async evaluate(
    batch: JudgmentBatch,
    options: Options,
    config: OpenClawConfig,
    registry: PluginRegistry,
    consumerId?: string,
  ): Promise<JudgmentOutcome> {
    options.signal.throwIfAborted();
    let submitted: JudgmentBatch;
    try {
      submitted = structuredClone(batch);
    } catch {
      throw new JudgmentContractError();
    }
    const instance = getPluginInstance(this.record);
    if (this.retired || this.reloadPause || !instance?.acceptingCalls || instance.owner?.revoked) {
      return this.unavailable("retiring");
    }
    const health = this.generation(config);
    const configBound = getRuntimeConfigSnapshot() === config;
    if (!instance.runInRegistry(registry, () => this.ready())) {
      return this.unavailable("credentials-unavailable");
    }
    if (health.authFailed || health.openUntil > performance.now() || health.trial) {
      return this.unavailable("circuit-open");
    }
    if (this.pending.size >= MAX_CONCURRENT) {
      return this.unavailable("overloaded");
    }
    const halfOpen = health.openUntil > 0;
    if (halfOpen) {
      health.trial = true;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, controller.signal]);
    const started = performance.now();
    const budget = Math.min(options.timeoutMs, 5_000);
    const deadlineMonotonicMs = started + budget;
    const timer = setTimeout(() => controller.abort("judgment-deadline"), budget);
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.pending.set(controller, { consumerId, done });
    const interrupted = (): JudgmentOutcome | undefined => {
      options.signal.throwIfAborted();
      if (controller.signal.reason instanceof JudgmentConsumerClosedError) {
        throw controller.signal.reason;
      }
      if (this.retired || controller.signal.reason === "judgment-provider-retired") {
        return this.unavailable("retiring");
      }
      if (
        controller.signal.reason === "judgment-deadline" ||
        performance.now() >= deadlineMonotonicMs
      ) {
        return this.unavailable("deadline");
      }
      if (
        getActiveSecretsRuntimeSnapshotRevisionState() !== health.secretRevision ||
        this.health !== health ||
        (configBound &&
          (getRuntimeConfigSnapshot()?.plugins !== config.plugins ||
            getRuntimeConfigSnapshot()?.judgments !== config.judgments))
      ) {
        return this.unavailable("retiring");
      }
      return undefined;
    };
    try {
      // Await physical settlement. A callback that ignores abort keeps its native lease
      // and is fenced by normal failed-drain recovery, never detached as "disposed".
      let outcome;
      try {
        outcome = await instance.runInRegistry(registry, () =>
          this.provider.evaluate(structuredClone(submitted), { signal, deadlineMonotonicMs }),
        );
      } catch {
        const stopped = interrupted();
        if (stopped) {
          if (stopped.status === "unavailable" && stopped.reason === "deadline") {
            this.fail(health, "transport");
          }
          return stopped;
        }
        throw new JudgmentContractError();
      }
      const stopped = interrupted();
      if (stopped) {
        if (stopped.status === "unavailable" && stopped.reason === "deadline") {
          this.fail(health, "transport");
        }
        return stopped;
      }
      if (outcome?.status === "ok") {
        if (!validateJudgmentResult(submitted, outcome.result)) {
          this.fail(health, "invalid-response");
          return this.unavailable("invalid-response");
        }
        health.failures = 0;
        health.openUntil = 0;
        health.lastSuccessAt = Date.now();
        this.successCount++;
        this.inputTokens += outcome.result.usage?.inputTokens ?? 0;
        this.outputTokens += outcome.result.usage?.outputTokens ?? 0;
        return {
          status: "ok",
          result: structuredClone(outcome.result),
          provenance: {
            providerId: this.provider.id,
            rubricVersion: options.rubricVersion,
            runtimeGeneration: health.id,
          },
        };
      }
      if (outcome?.status !== "unavailable" || !FAILURE_REASONS.has(outcome.reason)) {
        throw new JudgmentContractError();
      }
      this.fail(health, outcome.reason, outcome.retryAfterMs);
      return this.unavailable(outcome.reason);
    } catch (error) {
      options.signal.throwIfAborted();
      if (controller.signal.reason instanceof JudgmentConsumerClosedError) {
        throw controller.signal.reason;
      }
      if (error instanceof JudgmentContractError) {
        throw error;
      }
      // A malformed provider envelope must not leak getter/implementation diagnostics.
      throw new JudgmentContractError();
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
      if (halfOpen) {
        health.trial = false;
      }
      this.totalLatencyMs += performance.now() - started;
      settle();
    }
  }

  private fail(health: Health, reason: ProviderFailureReason, retryAfterMs?: number): void {
    if (
      this.health !== health ||
      getActiveSecretsRuntimeSnapshotRevisionState() !== health.secretRevision ||
      this.retired ||
      this.reloadPause
    ) {
      return;
    }
    if (reason === "authentication") {
      health.authFailed = true;
      return;
    }
    if (reason === "unsupported-input" || reason === "credentials-unavailable") {
      return;
    }
    health.failures++;
    const retryAfter =
      typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
        ? Math.max(0, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS))
        : 0;
    if (health.failures >= 3 || retryAfter > 0) {
      health.openUntil = performance.now() + Math.max(COOLDOWN_MS, retryAfter);
    }
  }
}
