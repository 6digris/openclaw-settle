import type { SqlBool } from "kysely";
import type { USER_PROFILE_AVATAR_MIME_TYPES } from "../shared/avatar-limits.js";

export const MAX_USER_PROFILE_DISPLAY_NAME_LENGTH = 256;

export type UserProfileAvatarMime = (typeof USER_PROFILE_AVATAR_MIME_TYPES)[number];

export type UserProfileEmailBinding = {
  email: string;
  profileId: string;
  bindingId: string | null;
};

export type UserProfileAccessFacts = Readonly<{
  profileId: string;
  emails: readonly string[];
  assignedRole: string | null;
}>;

export type PreparedUserProfileIdentity = {
  readonly emailBindingIds: readonly string[];
  assertCurrent(this: void, requiredEmailBindingIds?: readonly string[]): void;
  readCurrentProfile(this: void): UserProfileAccessFacts;
  readCurrentAliases(this: void): ReadonlySet<string>;
  release(this: void): void;
};

export type UserProfileEmailBindingIndex = {
  byEmail: Map<string, UserProfileEmailBinding>;
  byId: Map<string, string>;
  emailsByProfile: Map<string, Set<string>>;
};

export type UserProfilesDatabase = {
  user_profiles: {
    id: string;
    display_name: string | null;
    primary_github_account_id?: number | null;
    avatar: Uint8Array | null;
    avatar_mime: string | null;
    avatar_sha256: string | null;
    merged_into: string | null;
    role?: string | null;
    created_at: number;
    updated_at: number;
  };
  user_profile_emails: {
    email: string;
    profile_id: string;
    binding_id: string | null;
    created_at: number;
  };
  user_profile_identities: {
    provider: string;
    subject: string;
    profile_id: string;
    canonical_login: string | null;
    created_at: number;
  };
};

export type ProfileDisplayRow = Pick<
  UserProfilesDatabase["user_profiles"],
  "id" | "display_name" | "avatar_mime" | "avatar_sha256" | "merged_into" | "updated_at" | "role"
> & { has_avatar: SqlBool };
