import type { ConfigWriteOptions } from "./io.types.js";
/** Keep the original lock owner current across a prepared writer's awaited hooks. */
export function withConfigWriteLockGuard(
  sourceGuard: (() => void) | undefined,
  options: ConfigWriteOptions,
): ConfigWriteOptions {
  if (!sourceGuard) {
    return options;
  }
  return {
    ...options,
    assertConfigPathForWrite: () => {
      sourceGuard();
      options.assertConfigPathForWrite?.();
    },
    beforeCommit: async () => {
      await options.beforeCommit?.();
      sourceGuard();
    },
  };
}
