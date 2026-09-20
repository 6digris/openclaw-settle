import type { GatewaySessionRow } from "../api/types.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

type SidebarChildSessionParentsHost = {
  isSessionChildrenExpanded(session: SidebarRecentSession): boolean;
  mainSessionRow(agentId: string): GatewaySessionRow | null;
  projectHomeSession(row: GatewaySessionRow, agentId: string): SidebarRecentSession;
};

/** Expanded or active trees and visible home cards share the child-read frontier. */
export function collectSidebarChildSessionParents(
  host: SidebarChildSessionParentsHost,
  rows: readonly SidebarRecentSession[],
  homeAgents: readonly string[],
): Set<string> {
  const revalidating = new Set<string>();
  const pending = [...rows];
  while (pending.length > 0) {
    const session = pending.shift();
    if (!session) {
      continue;
    }
    pending.push(...session.children);
    if (
      (session.childLoadParentKeys?.length ?? 0) > 0 &&
      (session.visuallyActive || host.isSessionChildrenExpanded(session))
    ) {
      for (const key of session.childLoadParentKeys ?? [session.key]) {
        revalidating.add(key);
      }
    }
  }
  for (const agentId of homeAgents) {
    const mainRow = host.mainSessionRow(agentId);
    if (mainRow?.childSessions?.length) {
      for (const key of host.projectHomeSession(mainRow, agentId).childLoadParentKeys ?? []) {
        revalidating.add(key);
      }
    }
  }
  return revalidating;
}
