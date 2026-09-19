import { afterEach, beforeEach } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../src/config/runtime-snapshot.js";
import { publishSystemEventStoreConfig } from "../../../src/config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import {
  getPublishedSystemEventStoreSelection,
  publishSystemEventStoreSelection,
} from "../../../src/infra/system-event-ownership.js";

export function acceptSessionEventStoreTestConfig(cfg: OpenClawConfig): void {
  setRuntimeConfigSnapshot(cfg);
  publishSystemEventStoreConfig(cfg);
}

/** Preserve both the runtime snapshot and notification owner's independently published selection. */
export function captureSessionEventStoreTestConfig(): () => void {
  const previous = getRuntimeConfigSnapshot();
  const previousSource = getRuntimeConfigSourceSnapshot();
  const previousSelection = getPublishedSystemEventStoreSelection();
  return () => {
    if (previous) {
      setRuntimeConfigSnapshot(previous, previousSource ?? undefined);
    } else {
      clearRuntimeConfigSnapshot();
    }
    publishSystemEventStoreSelection(previousSelection);
  };
}

/** Give standalone notification fixtures an accepted config in their isolated test state. */
export function installSessionEventStoreTestConfig(): void {
  let restore: () => void;
  beforeEach(() => {
    restore = captureSessionEventStoreTestConfig();
    acceptSessionEventStoreTestConfig({});
  });
  afterEach(() => restore());
}
