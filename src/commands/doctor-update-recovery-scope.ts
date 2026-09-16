import type { UpdateRecoveryBackupRef } from "../infra/update-recovery-backup-contract.js";
import type { RuntimeEnv } from "../runtime.js";
import type { beginDoctorMaintenance } from "./doctor-maintenance.js";

export type DoctorRecoveryScope = {
  runtime: RuntimeEnv;
  active: boolean;
  guard?: () => void;
  refusal?: { error: unknown };
  prepared: boolean;
  protected: boolean;
  rehearsal?: boolean;
  storesClosed?: boolean;
  backup?: UpdateRecoveryBackupRef;
  backupRunId?: string;
  completeForwardRecovery?: () => Promise<void>;
  resolved?: UpdateRecoveryBackupRef;
  reference?: UpdateRecoveryBackupRef;
  assertRecoveryClaim?: () => void;
  revalidatePendingRecovery?: () => Promise<void>;
  maintenance?: Awaited<ReturnType<typeof beginDoctorMaintenance>>;
};
