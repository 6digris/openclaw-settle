import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { tryReadJson } from "../../infra/json-files.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import type { UpdateCandidateRehearsal } from "../../infra/update-candidate-rehearsal.js";
import {
  readUpdateStateSchemaVersions,
  resolveUpdateStateContentVersion,
} from "../../infra/update-candidate-state.js";
import {
  createUpdateDoctorConfigWarningStep,
  type UpdateDoctorConfigChange,
} from "../../infra/update-doctor-config.js";
import { resolveUpdateFinalizationTimeoutMs } from "../../infra/update-finalization-budget.js";
import { parkForegroundUpdateHandoff } from "../../infra/update-managed-service-handoff.js";
import { recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { readPackageVersion, UpdatePreMutationError } from "./shared.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import type { UpdateProfileContext } from "./update-command-finish-types.js";
import { readUpdateCandidateSource } from "./update-command-managed-context.js";
import { runUpdateCommandRepair } from "./update-command-repair.js";
import { isUpdatedInstallGatewayExecutorSupported } from "./update-command-service-command.js";
import { resolveUpdatedInstallCommandEnv } from "./update-command-service-env.js";
import {
  recordPreviousGatewayVerification,
  verifyPreviousGatewayForUpdate,
} from "./update-command-verification.js";

type ProfileValidation = {
  root: string;
  doctorConfigWrites: boolean;
  doctorConfigChanges: UpdateDoctorConfigChange[];
  validatedConfig?: {
    config: UpdateCandidateRehearsal["sourceConfig"];
    hash: UpdateCandidateRehearsal["sourceConfigHash"];
  };
  observedGatewayStartupMs?: number;
  profileContexts: boolean;
  gatewayRestartCompletion: boolean;
  generation: number;
};

export class UpdateCandidateValidation {
  readonly profileValidation = new Map<UpdateProfileContext, ProfileValidation>();
  admittedSchemaVersions: OpenClawSchemaVersions | undefined;
  schemaVersions: OpenClawSchemaVersions | undefined;
  previousSchemaVersions: OpenClawSchemaVersions | undefined;
  failureReason: string | undefined;
  generation = 0;
  mutationStarted = false;

  constructor(
    private readonly params: MutableUpdateExecutionParams,
    private readonly profiles: UpdateProfileContext[],
    private readonly context: {
      mode: UpdateRunResult["mode"];
      opts: MutableUpdateExecutionParams["opts"];
      updateStepTimeoutMs: number;
      assertCurrent: () => void;
      recheckSchemas: (versions: OpenClawSchemaVersions | undefined) => Promise<void>;
      prepareProfileRuntime: (
        profile: UpdateProfileContext,
        root: string,
        assertCurrent?: () => void,
      ) => Promise<void>;
      stopManagedServices: (phase: "prepare") => Promise<void>;
    },
  ) {
    this.admittedSchemaVersions = params.packageTargetSchemaVersions;
  }

  readonly envFor = (profile: UpdateProfileContext) =>
    profile.ownedManagedUpdateEnv ?? this.context.opts.run?.env ?? process.env;
  readonly nodeFor = (profile: UpdateProfileContext) =>
    profile.packageUpdateNodeRunner ?? this.params.packageUpdateNodeRunner;

  validateProfile = async (profile: UpdateProfileContext, root: string, allowRepair: boolean) => {
    const state = this.profileValidation.get(profile)!;
    this.context.assertCurrent();
    const env = this.envFor(profile);
    if (this.context.opts.run) {
      recordUpdateRunPhase(this.context.opts.run.runId, "validating", undefined, {
        env: this.context.opts.run.env,
      });
    }
    const validate = async (
      signal?: AbortSignal,
      rehearsal?: UpdateCandidateRehearsal,
      assertCurrent?: () => void,
    ) => {
      signal?.throwIfAborted();
      try {
        await this.context.prepareProfileRuntime(profile, root, assertCurrent);
        if (this.params.updateInstallKind === "package") {
          // The staged manifest owns schema support, including artifacts without registry metadata.
          await this.context.recheckSchemas(
            parsePackageOpenClawSchemaVersions(
              await tryReadJson<unknown>(path.join(root, "package.json")),
            ) ?? this.admittedSchemaVersions,
          );
          signal?.throwIfAborted();
          assertCurrent?.();
        }
      } catch (error) {
        if (error instanceof UpdatePreMutationError) {
          this.failureReason = error.reason;
        }
        throw error;
      }
      if (
        this.params.shouldRestart &&
        this.context.opts.run &&
        profile.preManagedServiceStop?.serviceUpdateVerdict?.kind === "owned"
      ) {
        const executor = this.context.opts.run.executorFence;
        if (!executor) {
          throw new UpdatePreMutationError(
            "target-native-unsupported",
            "Native candidate admission requires its original update executor.",
          );
        }
        const supported = await isUpdatedInstallGatewayExecutorSupported({
          root,
          env: resolveUpdatedInstallCommandEnv({
            processEnv: env,
            invocationCwd: this.params.invocationCwd,
          }),
          executor,
          timeoutMs: this.context.updateStepTimeoutMs,
          nodeRunner: this.nodeFor(profile),
          signal,
        });
        this.context.assertCurrent();
        if (!supported) {
          this.failureReason = "target-native-unsupported";
          throw new UpdatePreMutationError(
            this.failureReason,
            "Target runtime cannot fence update-owned native commands; refusing before Gateway stop or package activation.",
          );
        }
      }
      const snapshot = rehearsal
        ? { config: rehearsal.sourceConfig, hash: rehearsal.sourceConfigHash }
        : (state.validatedConfig ??
          (await readUpdateCandidateSource(env, this.params.legacyConfigPlan)));
      const validation = await validateUpdateCandidateCanary({
        root,
        config: snapshot.config,
        stateDir: resolveStateDir(env),
        env,
        signal,
        rehearsal,
        assertCurrent: () => {
          this.context.assertCurrent();
          assertCurrent?.();
        },
        nodeRunner: this.nodeFor(profile),
        timeoutMs: this.params.timeoutMs,
        onStep: (step) => this.params.progress?.onStepComplete?.({ ...step, index: 0, total: 0 }),
      });
      this.context.assertCurrent();
      state.doctorConfigChanges.push(...(validation.doctorConfigChanges ?? []));
      if (validation.status === "ok") {
        state.validatedConfig = snapshot;
        this.schemaVersions = validation.candidateSchemaVersions;
        state.profileContexts = validation.profileContexts;
        state.gatewayRestartCompletion = validation.gatewayRestartCompletion;
        state.generation = this.generation;
        state.doctorConfigWrites = validation.doctorConfigWrites === true;
        state.observedGatewayStartupMs = validation.steps.find(
          (step) => step.name === "candidate gateway canary" && step.exitCode === 0,
        )?.durationMs;
      }
      return validation;
    };
    let validation = await validate();
    if (validation.status === "error") {
      this.failureReason = validation.reason;
      if (!allowRepair) {
        return validation.steps;
      }
      this.generation += 1;
      const repair = await runUpdateCommandRepair({
        root: this.params.root,
        candidateRoot: root,
        env,
        run: this.context.opts.run,
        phase: "validating",
        nodeRunner: this.nodeFor(profile),
        result: {
          status: "error",
          mode: this.context.mode,
          root,
          reason: validation.reason,
          before: { version: await readPackageVersion(this.params.root) },
          after: { version: await readPackageVersion(root) },
          steps: validation.steps,
          durationMs: validation.durationMs,
        },
        validate: async (signal, assertCurrent, rehearsal) => {
          const repairValidation = await validate(signal, rehearsal, assertCurrent);
          return {
            ok: repairValidation.status === "ok",
            score: repairValidation.steps.filter((step) => step.exitCode === 0).length,
            summary:
              repairValidation.status === "ok"
                ? "Candidate validation passed."
                : repairValidation.logTail.join("\n"),
          };
        },
      });
      if (repair.status !== "repaired") {
        if (repair.reason === "requester-revoked") {
          this.failureReason = repair.reason;
        }
        return validation.steps;
      }
      this.failureReason = undefined;
      // Repair's disposable state is gone; only surviving candidate changes may authorize activation.
      validation = await validate();
      this.failureReason = validation.status === "error" ? validation.reason : undefined;
    }
    if (
      validation.status === "ok" &&
      !state.doctorConfigWrites &&
      state.doctorConfigChanges.length
    ) {
      const warning = createUpdateDoctorConfigWarningStep(root, state.doctorConfigChanges);
      validation.steps.push(warning);
      this.params.progress?.onStepComplete?.({ ...warning, index: 0, total: 0 });
    }
    return validation.steps;
  };
  private captureProfileSchemas = async (profile: UpdateProfileContext) => {
    const state = this.profileValidation.get(profile)!;
    const env = this.envFor(profile);
    profile.schemaVersions = this.schemaVersions
      ? await readUpdateStateSchemaVersions({
          stateDir: resolveStateDir(env),
          config: state.validatedConfig?.config ?? profile.configSnapshot.config,
          env,
          timeoutMs: this.context.updateStepTimeoutMs,
          nodeRunner: this.nodeFor(profile),
        })
      : undefined;
    this.context.assertCurrent();
    const candidate = this.schemaVersions;
    const missingCompletionOwner =
      this.context.opts.run?.completionOwner === "gateway-restart" &&
      !state.gatewayRestartCompletion;
    if (
      candidate &&
      ((this.profiles.length > 1 && !state.profileContexts) || missingCompletionOwner)
    ) {
      const sharedPath = resolveOpenClawStateSqlitePath(env);
      const schemaTransition = profile.schemaVersions?.some((entry) => {
        const version = resolveUpdateStateContentVersion(entry);
        return (
          version !== null && version !== candidate[entry.path === sharedPath ? "state" : "agent"]
        );
      });
      if (schemaTransition) {
        throw new UpdatePreMutationError(
          "target-native-unsupported",
          missingCompletionOwner
            ? "Target runtime cannot preserve the foreground Gateway's completion owner after state migration; refusing activation."
            : "Target runtime cannot finalize migrated state for every profile sharing this installation; refusing activation.",
        );
      }
    }
  };
  beforeActivate = async () => {
    this.context.assertCurrent();
    await this.context.recheckSchemas(this.admittedSchemaVersions);
    this.previousSchemaVersions = parsePackageOpenClawSchemaVersions(
      await tryReadJson<unknown>(path.join(this.params.root, "package.json")),
    );
    this.context.assertCurrent();
    let activationTimeoutMs = 0;
    for (const profile of this.profiles) {
      const state = this.profileValidation.get(profile)!;
      const env = this.envFor(profile);
      const snapshot = await readUpdateCandidateSource(env, this.params.legacyConfigPlan);
      this.context.assertCurrent();
      if (
        state.validatedConfig?.hash !== undefined &&
        snapshot.hash !== state.validatedConfig.hash
      ) {
        throw new UpdatePreMutationError(
          "invalid-config",
          "Config changed during candidate validation; rerun the update before activating.",
        );
      }
      await this.captureProfileSchemas(profile);
      profile.previousVerified = false;
      if (
        profile.preManagedServiceStop?.running &&
        profile.preManagedServiceStop.serviceUpdateVerdict?.kind === "owned"
      ) {
        profile.previousVerified = await verifyPreviousGatewayForUpdate({
          root: state.root,
          config: snapshot.config,
          env,
          opts: this.context.opts,
          timeoutMs: this.params.timeoutMs,
          observedStartupMs: state.observedGatewayStartupMs,
          assertCurrent: this.context.assertCurrent,
        });
        this.context.assertCurrent();
        if (profile === this.profiles[0]) {
          recordPreviousGatewayVerification(this.context.opts.run, profile.previousVerified);
        }
      }
      activationTimeoutMs += await resolveUpdateFinalizationTimeoutMs(
        this.context.updateStepTimeoutMs,
        {
          env,
          databases: profile.schemaVersions,
          observedStartupMs: state.observedGatewayStartupMs,
          pluginCount: Object.keys(snapshot.config.plugins?.entries ?? {}).length,
          nodeRunner: this.nodeFor(profile),
        },
      );
      this.context.assertCurrent();
    }
    // Candidate and readiness work can outlive any inspected service/config generation.
    await this.context.recheckSchemas(this.admittedSchemaVersions);
    this.context.assertCurrent();
    if (this.context.opts.run?.completionOwner === "gateway-restart") {
      await parkForegroundUpdateHandoff({ root: this.params.root, run: this.context.opts.run });
      this.context.assertCurrent();
    }
    await this.params.prepareMutableUpdate(this.envFor(this.profiles[0]!), activationTimeoutMs);
    this.context.assertCurrent();
    if (this.context.opts.run) {
      recordUpdateRunPhase(this.context.opts.run.runId, "activating", undefined, {
        env: this.context.opts.run.env,
      });
    }
    await this.context.stopManagedServices("prepare");
    await this.context.recheckSchemas(this.admittedSchemaVersions);
    for (const profile of this.profiles) {
      await this.captureProfileSchemas(profile);
    }
    this.context.assertCurrent();
    for (const profile of this.profiles) {
      profile.preManagedServiceStop?.windowsTaskAutoStartRecovery?.beginMutation();
    }
    this.mutationStarted = true;
    this.params.onActivation?.();
  };
}
