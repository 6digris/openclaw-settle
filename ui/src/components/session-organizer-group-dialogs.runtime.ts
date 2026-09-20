import { t } from "../i18n/index.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-controller-types.ts";

type GroupOperations = Pick<
  typeof import("./session-organizer-operations.runtime.ts"),
  "createSessionGroup" | "updateSessionGroupDefaults"
>;
type LoadGroupOperations = (scope: SidebarSessionMutationScope) => Promise<GroupOperations | null>;
type InputDialogOpener = (typeof import("./input-dialog.ts"))["showInputDialog"];
type SessionGroupDefaultsDialogOpener =
  (typeof import("./session-group-defaults-dialog.ts"))["showSessionGroupDefaultsDialog"];

/** A dialog that never opens still owes the operator a visible outcome. */
async function loadInputDialog(
  host: SessionOrganizerControllerHost,
): Promise<InputDialogOpener | null> {
  try {
    return (await import("./input-dialog.ts")).showInputDialog;
  } catch (error) {
    const scope = host.sessionData.beginSessionMutation();
    if (scope) {
      host.sessionData.publishSessionMutationError(scope, error);
    }
    return null;
  }
}

export async function createSessionGroup(
  host: SessionOrganizerControllerHost,
  sessions: readonly SidebarRecentSession[],
  loadOperations: LoadGroupOperations,
): Promise<void> {
  const showInputDialog = await loadInputDialog(host);
  await showInputDialog?.({
    title: t("sessionsView.newGroupTitle"),
    label: t("sessionsView.newGroupPrompt"),
    submitLabel: t("sessionsView.newGroupCreate"),
    requireValue: true,
    submit: (name) => writeSessionGroup(host, name, sessions, loadOperations),
  });
}

/**
 * Replays the failure the mutation already recorded so the dialog can keep the
 * typed name for a retry. A replaced connection confirmed neither the group nor
 * the move, so it reports a retryable message too rather than closing on an
 * outcome that never landed; resubmitting runs against the new connection.
 */
async function writeSessionGroup(
  host: SessionOrganizerControllerHost,
  name: string,
  sessions: readonly SidebarRecentSession[],
  loadOperations: LoadGroupOperations,
): Promise<string | null> {
  const scope = host.sessionData.beginSessionMutation();
  if (!scope) {
    return t("sessionsView.newGroupFailed");
  }
  const operations = await loadOperations(scope);
  if (!operations) {
    return host.sessionData.isSessionMutationScopeCurrent(scope)
      ? sessionGroupFailure(host)
      : t("sessionsView.newGroupStale");
  }
  const result = await operations.createSessionGroup(host, name, sessions, scope);
  if (result === "failed") {
    return sessionGroupFailure(host);
  }
  return result === "stale" ? t("sessionsView.newGroupStale") : null;
}

function sessionGroupFailure(host: SessionOrganizerControllerHost): string {
  return host.sessionData.sessionMutationError ?? t("sessionsView.newGroupFailed");
}

export async function promptSessionGroupName(
  host: SessionOrganizerControllerHost,
  group: string,
): Promise<string | null | undefined> {
  const showInputDialog = await loadInputDialog(host);
  // requireChange holds the submit closed on the name the group already has,
  // so the only rename that reaches the Gateway is one that changes something.
  return await showInputDialog?.({
    title: t("sessionsView.renameGroupTitle", { group }),
    label: t("sessionsView.groupNameLabel"),
    defaultValue: group,
    requireValue: true,
    requireChange: true,
  });
}

export async function editSessionGroupDefaults(
  host: SessionOrganizerControllerHost,
  group: string,
  loadOperations: LoadGroupOperations,
): Promise<void> {
  let showDialog: SessionGroupDefaultsDialogOpener;
  try {
    showDialog = (await import("./session-group-defaults-dialog.ts"))
      .showSessionGroupDefaultsDialog;
  } catch (error) {
    const scope = host.sessionData.beginSessionMutation();
    if (scope) {
      host.sessionData.publishSessionMutationError(scope, error);
    }
    return;
  }
  const defaults = host.sessionGroupDefaults(group);
  if (defaults) {
    await showDialog({
      group,
      defaults,
      listDirectory: (path) => host.listSessionGroupFolders(path),
      inspectRepository: (path) => host.inspectSessionGroupRepository(path),
      submit: async (nextDefaults) => {
        const scope = host.sessionData.beginSessionMutation();
        if (!scope || !host.sessionGroupDefaults(group)) {
          return t("sessionsView.groupDefaultsStale");
        }
        const operations = await loadOperations(scope);
        const result = await operations?.updateSessionGroupDefaults(
          host,
          group,
          { cwd: nextDefaults.cwd || null, worktree: nextDefaults.worktree },
          scope,
        );
        return result === "completed"
          ? null
          : result === "stale"
            ? t("sessionsView.groupDefaultsStale")
            : (host.sessionData.sessionMutationError ?? t("sessionsView.groupDefaultsFailed"));
      },
    });
  }
}
