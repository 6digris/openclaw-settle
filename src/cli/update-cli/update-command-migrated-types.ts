import type { TriageFailureContext } from "../../commands/triage-prompt.js";
import type {
  UpdateRequester,
  UpdateRequesterAuthority,
} from "../../infra/update-requester-authority.js";
import type { UpdateRunStep } from "../../infra/update-run-record.js";
import type { UpdateRecoveryHandoff } from "../../infra/update-run-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateCommandChildGrant } from "./update-command-executor.js";
import type { FinishUpdateParams, UpdateProfileContext } from "./update-command-finish-types.js";

export type UpdateDoctorInput = {
  executor: UpdateCommandChildGrant;
  runId: string;
  root: string;
  configInputHash: string;
  requester?: UpdateRequester;
  repair: boolean;
};

type MigratedUpdateProfileContext = Omit<UpdateProfileContext, "preManagedServiceStop"> & {
  preManagedServiceStop?: Omit<
    NonNullable<UpdateProfileContext["preManagedServiceStop"]>,
    "windowsTaskAutoStartRecovery"
  >;
  windowsTaskAutoStartSuspended?: true;
};

export type MigratedUpdateFinalizationInput = {
  params: Omit<FinishUpdateParams, "packageTransaction" | "profiles" | "opts"> & {
    opts: Omit<FinishUpdateParams["opts"], "run" | "recovery" | "onResult" | "sourceUpdate"> & {
      run?: Omit<
        NonNullable<FinishUpdateParams["opts"]["run"]>,
        "requesterAuthority" | "executorFence"
      > & {
        requesterAuthority?: Pick<UpdateRequesterAuthority, "requester">;
      };
    };
    profiles: MigratedUpdateProfileContext[];
  };
  executor?: UpdateCommandChildGrant;
  recoveryHandoff?: UpdateRecoveryHandoff;
  bufferedSteps: UpdateRunStep[];
  resultPath: string;
};

/** Published v2026.9.3/v2026.9.4 drivers transfer exactly one profile. */
export type LegacyMigratedUpdateFinalizationInput = Omit<
  MigratedUpdateFinalizationInput,
  "params"
> & {
  params: Omit<MigratedUpdateFinalizationInput["params"], "profiles"> &
    Omit<MigratedUpdateProfileContext, "windowsTaskAutoStartSuspended">;
  windowsTaskAutoStartSuspended?: true;
};

export type MigratedUpdateFinalizationResult = {
  result: UpdateRunResult;
  exitCode: number;
  executorDelegation?: "pid-start-v1";
  automaticTriage?: TriageFailureContext;
} & (
  | { terminalRunId: string; restartRunId?: never }
  | { restartRunId: string; terminalRunId?: never }
);
