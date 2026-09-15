// Discord test API exposes transcript-provider fixtures without deep extension imports.
export { createDiscordDraftPreviewController } from "./src/monitor/message-handler.draft-preview.js";
export { RequestClient } from "./src/internal/discord.js";
export {
  discordVoiceTranscriptsSourceProvider,
  setDiscordTranscriptsVoiceManager,
} from "./src/voice/transcripts-source.js";

// Voice harness mocks must remain opt-in for provider-only integration tests.
export const loadDiscordVoiceTestHarness = () =>
  import("./src/voice/voice-test-harness.test-support.js");

// Gateway capture proof keeps routing/admission real; only transport edges are substituted.
export const loadDiscordGatewayCaptureFixture = () =>
  import("./src/voice/voice-gateway-capture.test-support.js");

// Registration proof substitutes persistence, not the FIFO or managed SDK owner.
export const loadDiscordComponentRegistryTestHarness = () =>
  import("./src/components-registry.test-support.js");
