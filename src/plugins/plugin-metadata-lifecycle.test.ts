import { expect, it, vi } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  getCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
} from "./current-plugin-metadata-state.js";
import { getPluginCache } from "./plugin-cache.js";
import {
  clearPluginMetadataLifecycleCaches,
  registerPluginMetadataProcessMemoLifecycleClear,
  retainGatewayPluginMetadata,
} from "./plugin-metadata-lifecycle.js";

const clearMemo = vi.fn();
registerPluginMetadataProcessMemoLifecycleClear(clearMemo);

it("keeps boot metadata and process memos until the final Gateway releases them", () => {
  const firstAccessCache = getPluginCache();
  const releaseFirst = retainGatewayPluginMetadata();
  const releaseSecond = retainGatewayPluginMetadata();
  try {
    const snapshot = { plugins: [] };
    setCurrentPluginMetadataSnapshotState(
      snapshot,
      "boot",
      undefined,
      undefined,
      undefined,
      "gateway",
    );
    clearMemo.mockClear();

    clearPluginMetadataLifecycleCaches();
    releaseSecond();
    releaseSecond();

    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(snapshot);
    expect(clearMemo).not.toHaveBeenCalled();
    expect(getPluginCache()).toBe(firstAccessCache);

    releaseFirst();
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBeUndefined();
    expect(clearMemo).toHaveBeenCalledOnce();
    expect(getPluginCache()).not.toBe(firstAccessCache);
    releaseFirst();
    expect(clearMemo).toHaveBeenCalledOnce();
  } finally {
    releaseSecond();
    releaseFirst();
  }
});

it("keeps durable and incognito agent databases until the final Gateway releases them", async () => {
  const state = await createOpenClawTestState({ label: "gateway-agent-databases" });
  const releaseFirst = retainGatewayPluginMetadata();
  const releaseSecond = retainGatewayPluginMetadata();
  try {
    const options = { agentId: "main", env: state.env };
    const durable = openOpenClawAgentDatabase(options);
    const incognito = openOpenClawAgentDatabase({
      ...options,
      path: resolveIncognitoOpenClawAgentSqlitePath(options),
    });

    releaseFirst(closeOpenClawAgentDatabasesForTest);
    expect(durable.db.isOpen).toBe(true);
    expect(incognito.db.isOpen).toBe(true);

    releaseSecond(closeOpenClawAgentDatabasesForTest);
    expect(durable.db.isOpen).toBe(false);
    expect(incognito.db.isOpen).toBe(false);
  } finally {
    releaseSecond(closeOpenClawAgentDatabasesForTest);
    releaseFirst(closeOpenClawAgentDatabasesForTest);
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  }
});

it("allows startup planning metadata to refresh before a Gateway inventory is published", () => {
  const release = retainGatewayPluginMetadata();
  try {
    setCurrentPluginMetadataSnapshotState({ plugins: [] }, "planning");
    clearPluginMetadataLifecycleCaches();
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBeUndefined();
  } finally {
    release();
  }
});
