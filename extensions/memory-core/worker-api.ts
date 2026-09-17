// The host loads this entry point before native state paths are initialized.
export { serveMemoryWorker } from "./src/remote/memory-worker.js";
export type { MemoryWorkerOptions } from "./src/remote/memory-worker.js";
export type { MemoryWorkerHost, MemoryWorkerConfiguration } from "./src/remote/memory-native.js";
export {
  createGatewayMemoryBinding,
  createRemoteMemoryManager,
} from "./src/remote/memory-client.js";
export type {
  GatewayMemoryBindingOptions,
  RemoteMemoryManagerOptions,
  MemoryWorkerProcess,
} from "./src/remote/memory-client.js";
