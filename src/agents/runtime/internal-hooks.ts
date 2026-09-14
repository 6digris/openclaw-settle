export {
  acknowledgeInternalToolResult,
  appendToolLoopWarning,
  attachInternalToolBatchLifecycle,
  attachInternalToolExecutionPreparer,
  attachInternalToolResultAcknowledgement,
  attachInternalToolResultProvenance,
  copyInternalToolExecutionPreparer,
  copyInternalToolResultState,
  getInternalToolResultProvenance,
  getInternalToolExecutionPreparer,
  setInternalBeforeToolBatch,
  type InternalBeforeToolBatchHook,
  type InternalToolExecutionPreparer,
} from "../../../packages/agent-core/src/internal-hooks.js";

export { setAgentLoopObserver } from "../../../packages/agent-core/src/loop-diagnostics.js";
