import type { ChatMetadataProjectionFacts } from "./chat-metadata-session-projection.js";

export type PreparedAgentFacts = ChatMetadataProjectionFacts & {
  authStoreRevision: string;
  catalogStatusKey: string;
  skillsVersion: number;
};

export function agentFactsMatch(
  left: PreparedAgentFacts,
  right: PreparedAgentFacts | undefined,
): boolean {
  return (
    right?.agentId === left.agentId &&
    right.owner === left.owner &&
    right.authStoreRevision === left.authStoreRevision &&
    right.modelCatalog === left.modelCatalog &&
    right.catalogStatusKey === left.catalogStatusKey &&
    right.skillsVersion === left.skillsVersion
  );
}
