/** Production-private native session coordination for official harness plugins. */
export {
  createAgentHarnessAttemptDeadlineController,
  type AgentHarnessAttemptTimeout,
} from "../agents/harness/attempt-deadlines.js";
export {
  createNativeSessionBindingLifecycle,
  type NativeSessionBindingLeaseOptions,
  type NativeSessionBindingRecord,
  type NativeSessionBindingLifecycleOptions,
} from "../agents/harness/native-session/binding-lifecycle.js";
export {
  captureNativeSessionGenerationAuthority,
  reclaimNativeSessionGeneration,
  resolveNativeSessionBinding,
  type NativeSessionGenerationTarget,
  type NativeSessionGenerationAuthority,
  type NativeSessionGenerationOperations,
  type NativeSessionGenerationReclaimPlan,
  type NativeSessionGenerationAdoptionResult,
} from "../agents/harness/native-session/binding-generation.js";
export { createNativeSessionInitializationOwner } from "../agents/harness/native-session/initialization.js";
export { withNativeSessionBindingOwnership } from "../agents/harness/native-session/binding-ownership.js";
