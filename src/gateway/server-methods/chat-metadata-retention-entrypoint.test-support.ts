// Resolve the real metadata runtime in an isolated retention child.
export const chatMetadataRetentionEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "chat-metadata-retention.test-support",
  distWorkerPath: "gateway/server-methods/chat-metadata-retention.test-support.js",
} as const;
