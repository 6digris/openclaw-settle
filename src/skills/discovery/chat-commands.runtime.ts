// Runtime facade for chat command discovery without importing the full discovery module.
export {
  expandExplicitSkillReferences,
  findBundledSkillCommandForWorkspace,
  hasSkillReferenceCandidate,
  prepareSkillCommandsForWorkspace,
} from "./chat-commands.js";
export { resolveEffectiveAgentSkillFilter } from "./agent-filter.js";
