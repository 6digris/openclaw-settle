// Workspace access registration without loading agent execution runtime.
export {
  isWorkspaceAccessUnavailableError,
  WorkspaceAccessUnavailableError,
  declareAgentWorkspaceAccess,
  registerAgentWorkspaceAccess,
  getAgentWorkspaceAccess,
  prepareAgentWorkspaceAttachments,
  type AgentWorkspaceAccess,
} from "../agents/workspace-access.js";
export { createWorkspaceAttachmentPreparer } from "../agents/workspace-attachment-preparer.js";
export { createWorkspaceBootstrapFilePolicy } from "../agents/workspace-bootstrap-policy.js";
export { createWorkspaceMemoryFileClient } from "../agents/workspace-memory-client.js";
