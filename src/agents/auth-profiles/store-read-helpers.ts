import type { AuthProfileDatabase } from "./sqlite.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

export function withCredentialSources(
  store: AuthProfileStore,
  databasePath: string,
): RuntimeAuthProfileStore {
  return {
    ...store,
    runtimeCredentialSources: Object.fromEntries(
      Object.entries(store.profiles).map(([profileId, credential]) => [
        profileId,
        { databasePath, provider: credential.provider },
      ]),
    ),
  };
}

export function resolvePersistedLoadOptions(
  options: { allowKeychainPrompt?: boolean; database?: AuthProfileDatabase } | undefined,
): { allowKeychainPrompt?: boolean; database?: AuthProfileDatabase } {
  return {
    ...(options?.allowKeychainPrompt !== undefined
      ? { allowKeychainPrompt: options.allowKeychainPrompt }
      : {}),
    ...(options?.database ? { database: options.database } : {}),
  };
}
