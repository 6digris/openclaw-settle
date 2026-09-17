/** Dependency-light argv helpers for plugin CLI metadata and output-mode resolvers. */
export {
  consumeRootOptionToken,
  FLAG_TERMINATOR,
  getRootOptionAwareCommandPath,
  getCommandPositionalsWithRootOptions,
  isValueToken,
} from "../infra/cli-root-options.js";
