import type { AgentHarnessSessionDeletionParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createNativeSessionInitializationOwner } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import {
  validateBindingForWrite,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";

const codexInitializations = createNativeSessionInitializationOwner<
  CodexAppServerBindingStore,
  CodexAppServerBindingIdentity,
  CodexAppServerThreadBinding
>({
  validateBinding: validateBindingForWrite,
  writeBinding: (store, identity, binding, assertCurrent) =>
    store.mutate(identity, { kind: "set", if: { kind: "absent" }, binding }, assertCurrent),
  errors: {
    linkChanged: () => new Error("Codex initialization link changed before cleanup"),
    bindingChanged: () => new Error("Codex session binding changed during initialization"),
    linkWriteFailed: () => new Error("Codex initialization link could not be persisted"),
    ownerChanged: () => new Error("Codex initialization binding owner changed before rollback"),
  },
});

export const prepareCodexSessionInitialization = codexInitializations.prepare;

export function getCodexSessionInitializationRollback(
  store: CodexAppServerBindingStore,
  params: AgentHarnessSessionDeletionParams,
  identity: CodexAppServerBindingIdentity,
  binding: CodexAppServerThreadBinding | undefined,
): (() => Promise<void>) | undefined {
  return codexInitializations.getRollback({
    initialization: params.initialization,
    bindingStore: store,
    identity,
    binding,
  });
}
