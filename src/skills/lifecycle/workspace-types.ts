/** File-host status contracts shared by local discovery and remote workspace adapters. */
import type { ClawHubDownloadResult } from "../../infra/clawhub-artifacts.js";
import type { ClawHubSkillsShTrustState } from "../../infra/clawhub-skills.js";

export type ClawHubSkillDownloadedArtifactLock = {
  kind: ClawHubDownloadResult["artifact"];
  sha256: string;
  integrity: string;
};

export type ClawHubSkillFileLock = {
  path: string;
  sha256: string;
};

export type ClawHubSkillStatusLink =
  | {
      status: "linked";
      valid: true;
      registry: string;
      slug: string;
      ownerHandle?: string;
      requestedReference?: string;
      trustState?: ClawHubSkillsShTrustState;
      installedVersion: string;
      installedAt: number;
      originPath: string;
      lockPath: string;
      sourceUrl?: string;
      artifact?: ClawHubSkillDownloadedArtifactLock;
      skillFile?: ClawHubSkillFileLock;
      fileTreeSha256?: string;
    }
  | {
      status: "invalid";
      valid: false;
      reason: string;
      registry?: string;
      slug?: string;
      installedVersion?: string;
      installedAt?: number;
      originPath?: string;
      lockPath?: string;
    };

export type LocalSkillCardStatus = {
  present: true;
  path: string;
  sizeBytes: number;
};
