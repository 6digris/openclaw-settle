/** Shared keys only: runtime group reads must not load the Doctor migration graph. */
export const LEGACY_SESSION_GROUP_SECTION_ORDER_KEY = "sidebar.sectionOrder";
export const SESSION_GROUP_MIGRATION_KEY = "sessionGroups.agentOwnedCatalog";

/** The caller supplies the canonical agent ID selected by its existing owner. */
export function sessionGroupSectionOrderKey(agentId: string): string {
  return `${LEGACY_SESSION_GROUP_SECTION_ORDER_KEY}.agent:${agentId}`;
}
