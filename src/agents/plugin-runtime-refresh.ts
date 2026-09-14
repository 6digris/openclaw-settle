import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type Refresh = {
  active: boolean;
  holds: number;
  consumer?: () => boolean;
  requested: boolean;
  onRequested?: () => void;
};

const refreshScope = resolveGlobalSingleton(
  Symbol.for("openclaw.agentPluginRuntimeRefresh"),
  () => new AsyncLocalStorage<Refresh>(),
);

/** Captured host control survives plugin callbacks without becoming run authority. */
export function captureAgentPluginRuntimeRefresh() {
  const owner = refreshScope.getStore();
  return {
    bindConsumer: (isCurrent: () => boolean) => {
      if (owner?.active) {
        owner.consumer = isCurrent;
      }
    },
    request: (): boolean => {
      if (!owner?.active || owner.consumer?.() !== true) {
        return false;
      }
      owner.requested = true;
      try {
        void Promise.resolve(owner.onRequested?.()).catch(() => {});
      } catch {
        // The refresh request remains accepted when diagnostic collection fails.
      }
      return true;
    },
    isRequested: () => owner?.active === true && owner.requested,
    isPending: () => owner?.active === true && owner.requested && owner.holds === 0,
    hold: () => {
      if (!owner?.active) {
        return () => {};
      }
      owner.holds += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          owner.holds -= 1;
        }
      };
    },
    assertActive: () => {
      if (owner && !owner.active) {
        throw new Error("Plugin runtime changed. Continue with the refreshed tool catalog.");
      }
    },
    assertCurrent: () => {
      if (owner && (!owner.active || owner.requested)) {
        throw new Error(
          "Plugin runtime changed. Continue with the refreshed tool catalog; do not repeat completed actions.",
        );
      }
    },
  };
}

/** One visible run owns refresh requests across all of its prepared runtime generations. */
export function createAgentPluginRuntimeRefresh(onRequested?: () => void) {
  let owner: Refresh | undefined;
  const close = () => {
    if (owner) {
      owner.active = false;
      owner.consumer = undefined;
      owner.requested = false;
    }
  };
  return {
    run: <T>(run: () => T): T => {
      close();
      owner = { active: true, holds: 0, requested: false, onRequested };
      return refreshScope.run(owner, run);
    },
    close,
  };
}
