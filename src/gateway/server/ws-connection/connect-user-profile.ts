import { resolveHostAccountName } from "../../../infra/host-account-name.js";
import { prepareUserProfileRoleAuthority } from "../../../state/user-channel-identity-operations.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalUserProfileForTailscaleIdentity,
} from "../../../state/user-profile-writes.js";
import type { GatewayAuthResult } from "../../auth.js";
import type { createAuthenticatedGitHubIdentitySync } from "../../github-user-identity.js";

export async function resolveAuthenticatedProfile(
  profileId: string,
  updatedAt: number,
  assertCurrent?: () => void,
) {
  assertCurrent?.();
  const authority = await prepareUserProfileRoleAuthority(profileId);
  assertCurrent?.();
  if (!authority?.isCurrent()) {
    throw new Error("Gateway profile changed during acquisition");
  }
  const { id, displayName, avatarRevision, hasAvatar } = authority.display;
  return {
    profile: { profileId: id, displayName, avatarRevision, hasAvatar, updatedAt },
    authority,
  };
}

export async function resolveGatewayConnectUserProfile(params: {
  ownerProfileExpected: boolean;
  authenticatedUserId: string | undefined;
  authResult: GatewayAuthResult;
  resolveAuthenticatedGitHubIdentity: ReturnType<typeof createAuthenticatedGitHubIdentitySync>;
  assertCurrent?: () => void;
}) {
  params.assertCurrent?.();
  const options = { assertCurrent: params.assertCurrent };
  const ownerDisplayName = params.ownerProfileExpected ? await resolveHostAccountName() : undefined;
  params.assertCurrent?.();
  const profile = params.ownerProfileExpected
    ? await ensureCanonicalGatewayOwnerProfile(ownerDisplayName ?? null, options)
    : params.resolveAuthenticatedGitHubIdentity
      ? await params.resolveAuthenticatedGitHubIdentity()
      : params.authResult.tailscaleIdentity
        ? await ensureCanonicalUserProfileForTailscaleIdentity(
            params.authResult.tailscaleIdentity,
            options,
          )
        : await ensureCanonicalUserProfileForEmail(params.authenticatedUserId!, options);
  params.assertCurrent?.();
  const profileId = "profileId" in profile ? profile.profileId : profile.id;
  const resolved = await resolveAuthenticatedProfile(
    profileId,
    profile.updatedAt,
    params.assertCurrent,
  );
  params.assertCurrent?.();
  return resolved;
}
