import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import {
  createGatewayNotifierFixture,
  makeContextParams,
  registerGatewayNotifierFixtureHandler,
  verifyRetainedGatewayNotifier,
  verifyInflightGatewayNotifier,
} from "./server-request-context.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("./server/health-state.js", () => ({
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
  incrementPresenceVersion: vi.fn(() => 1),
}));

describe("createGatewayRequestContext", () => {
  it("runs a shipped public Gateway handler notification through the real reloader", async () => {
    const { reloader, onRestart, onHotReload, api, registry, instance } =
      await createGatewayNotifierFixture(tempDirs.make("openclaw-sdk-notifier-"));
    const params = makeContextParams();
    params.runtime.kernel.notifyPluginMetadataChanged = reloader.notifyPluginMetadataChanged;
    const context = createGatewayRequestContext(params);
    const { handler, request } = registerGatewayNotifierFixtureHandler({ api, registry }, context);
    await handler(request);
    expect(request.respond).toHaveBeenCalledWith(true, { notified: true }, undefined, undefined);
    await vi.waitFor(() => expect(onRestart).toHaveBeenCalledOnce());
    expect(onHotReload).not.toHaveBeenCalled();
    expect(params.runtime.kernel.applyPluginLifecycleChange).not.toHaveBeenCalled();
    const notify = context.notifyPluginMetadataChanged;
    await reloader.stop();
    notify();
    expect(onRestart).toHaveBeenCalledOnce();
    await instance.dispose();
    await expect(handler(request)).rejects.toThrow(/reloaded or disabled/i);
  });

  it("revokes a retained shipped notifier after plugin disposal while the Gateway stays live", async () => {
    const fixture = await createGatewayNotifierFixture(tempDirs.make("openclaw-sdk-retained-"));
    const params = makeContextParams();
    params.runtime.kernel.notifyPluginMetadataChanged =
      fixture.reloader.notifyPluginMetadataChanged;
    await verifyRetainedGatewayNotifier(fixture, createGatewayRequestContext(params));
  });

  it("preserves an admitted shipped notifier call while plugin disposal drains the handler", async () => {
    const fixture = await createGatewayNotifierFixture(tempDirs.make("openclaw-sdk-inflight-"));
    const params = makeContextParams();
    params.runtime.kernel.notifyPluginMetadataChanged =
      fixture.reloader.notifyPluginMetadataChanged;
    await verifyInflightGatewayNotifier(fixture, createGatewayRequestContext(params));
  });
});
