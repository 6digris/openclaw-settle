import type { ExecHost, ExecTarget } from "../infra/exec-approvals-core.js";
import { registerTrustedToolNoStartError } from "./tool-result-error.js";

/** Renders a host label for user-facing exec policy messages. */
function renderExecHostLabel(host: ExecHost) {
  return host === "sandbox" ? "sandbox" : host === "gateway" ? "gateway" : "node";
}

/** Renders an exec target label, preserving `auto`. */
export function renderExecTargetLabel(target: ExecTarget) {
  return target === "auto" ? "auto" : renderExecHostLabel(target);
}

/** Returns true when a per-call target override is allowed by configured policy. */
export function isRequestedExecTargetAllowed(params: {
  configuredTarget: ExecTarget;
  requestedTarget: ExecTarget;
  sandboxAvailable?: boolean;
}) {
  if (params.requestedTarget === params.configuredTarget) {
    return true;
  }
  if (params.configuredTarget === "auto") {
    if (
      params.sandboxAvailable &&
      (params.requestedTarget === "gateway" || params.requestedTarget === "node")
    ) {
      return false;
    }
    return true;
  }
  return false;
}

/** Resolves configured/requested/elevated exec target into an effective host. */
export function resolveExecTarget(params: {
  configuredTarget?: ExecTarget;
  requestedTarget?: ExecTarget | null;
  elevatedRequested: boolean;
  sandboxAvailable: boolean;
  sandboxRequired?: boolean;
}) {
  const sandboxRequired = params.sandboxRequired === true;
  if (sandboxRequired && !params.sandboxAvailable) {
    throw registerTrustedToolNoStartError(
      new Error("This session requires a sandbox, but its sandbox runtime is unavailable."),
    );
  }
  if (sandboxRequired && params.elevatedRequested) {
    throw registerTrustedToolNoStartError(
      new Error("Elevated execution is unavailable because this session requires a sandbox."),
    );
  }
  // Session isolation outranks every agent, session, and request-scoped host preference.
  const configuredTarget = sandboxRequired ? "auto" : (params.configuredTarget ?? "auto");
  const requestedTarget =
    params.requestedTarget === "auto" ? null : (params.requestedTarget ?? null);
  if (sandboxRequired && (requestedTarget === "gateway" || requestedTarget === "node")) {
    throw registerTrustedToolNoStartError(
      new Error(
        `exec host not allowed (requested ${renderExecTargetLabel(requestedTarget)}; this session requires a sandbox).`,
      ),
    );
  }
  if (
    requestedTarget &&
    !isRequestedExecTargetAllowed({
      configuredTarget,
      requestedTarget,
      sandboxAvailable: params.sandboxAvailable,
    })
  ) {
    const allowedConfig = Array.from(
      new Set(
        configuredTarget === "auto" &&
          params.sandboxAvailable &&
          (requestedTarget === "gateway" || requestedTarget === "node")
          ? [renderExecTargetLabel(requestedTarget)]
          : requestedTarget === "gateway" && !params.sandboxAvailable
            ? ["gateway", "auto"]
            : [renderExecTargetLabel(requestedTarget), "auto"],
      ),
    ).join(" or ");
    throw registerTrustedToolNoStartError(
      new Error(
        `exec host not allowed (requested ${renderExecTargetLabel(requestedTarget)}; ` +
          `configured host is ${renderExecTargetLabel(configuredTarget)}; ` +
          `set tools.exec.host=${allowedConfig} to allow this override).`,
      ),
    );
  }
  const selectedTarget = requestedTarget ?? configuredTarget;
  const resolvedTarget = params.elevatedRequested
    ? selectedTarget === "node"
      ? "node"
      : "gateway"
    : selectedTarget;
  const effectiveHost =
    resolvedTarget === "auto" ? (params.sandboxAvailable ? "sandbox" : "gateway") : resolvedTarget;
  return {
    configuredTarget,
    requestedTarget,
    selectedTarget: resolvedTarget,
    effectiveHost,
  };
}
