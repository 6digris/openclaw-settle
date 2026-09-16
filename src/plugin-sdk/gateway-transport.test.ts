import { expectTypeOf, it } from "vitest";
import type { WebSocket } from "ws";
import type { GatewayRequestHandlerOptions as CoreOptions } from "./core.js";
import type {
  GatewayRequestHandlerOptions as RuntimeOptions,
  NodeSession,
} from "./gateway-runtime.js";

it("exposes the same transport-aware V2 through both existing public entrypoints", () => {
  expectTypeOf<CoreOptions>().toEqualTypeOf<RuntimeOptions>();
  expectTypeOf<
    ReturnType<CoreOptions["context"]["nodeRegistry"]["listConnected"]>[number]
  >().toEqualTypeOf<NodeSession>();
  expectTypeOf<NonNullable<NodeSession["client"]["webSocket"]>>().toEqualTypeOf<WebSocket>();
  expectTypeOf<undefined>().toExtend<NodeSession["client"]["socket"]>();
  expectTypeOf<undefined>().toExtend<NodeSession["client"]["webSocket"]>();
  // Event delivery may override a real framed connection, as before V2.
  type Registry = CoreOptions["context"]["nodeRegistry"];
  expectTypeOf<Parameters<Registry["register"]>[0]>().toExtend<
    Parameters<Registry["registerTransport"]>[0]
  >();
});

// Typechecked consumer, not an unconditional socket cast or a simulated WebSocket.
function useNodeCapabilities({ context }: CoreOptions): void {
  for (const node of context.nodeRegistry.listConnected()) {
    const framed = node.client.socket;
    if (framed) {
      expectTypeOf(framed.readyState).toBeNumber();
      expectTypeOf<(typeof framed)["send"]>().toBeFunction();
    }
    const physical = node.client.webSocket;
    if (physical) {
      expectTypeOf(physical).toEqualTypeOf<WebSocket>();
      physical.pause();
      physical.resume();
      physical.ping();
      expectTypeOf(physical.protocol).toBeString();
      expectTypeOf(physical.binaryType).toBeString();
    }
  }
}

it("accepts a migrated handler through either entrypoint without a cast", () => {
  expectTypeOf(useNodeCapabilities).toExtend<(options: RuntimeOptions) => void>();
});
