import path from "node:path";
import {
  type AgentWorkspaceAccess,
  WorkspaceAccessUnavailableError,
} from "../../agents/workspace-access.js";
import { prepareSkillBundle } from "../library/bundle.js";
import type { Skill } from "../loading/skill-contract.js";
import { materializeSkillResources } from "../runtime/resources.js";

/** Gateway hooks inspect a local source tree, never a path supplied by the workspace host. */
export async function withSkillInstallPolicySource<T>(
  skill: Skill,
  access: AgentWorkspaceAccess | undefined,
  inspect: (sourceDir: string) => Promise<T>,
): Promise<T> {
  if (!access || skill.fileHost === "gateway") {
    return await inspect(path.resolve(skill.baseDir));
  }
  if (!access.skillResources) {
    throw new WorkspaceAccessUnavailableError("Remote skill policy source is unavailable");
  }
  const files = await access.skillResources.readSkillFiles(skill, { allowMissingRoot: false });
  if (!files) {
    throw new WorkspaceAccessUnavailableError("Remote skill policy source disappeared");
  }
  const bundle = prepareSkillBundle(files);
  const source = await materializeSkillResources(
    {
      version: 1,
      skills: [
        { name: skill.name, description: skill.description, revision: bundle.revision, files },
      ],
    },
    () => {},
  );
  try {
    return await inspect(path.join(source.directory, "0"));
  } finally {
    await source.cleanup();
  }
}
