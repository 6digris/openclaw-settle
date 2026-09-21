import type { ProviderRefusalReview } from "@openclaw/llm-core/diagnostics";

/** Runtime-authored precaution for one failed turn in this session generation. */
export type SessionProviderReview = {
  id: string;
  sessionId: string;
  runId: string;
  provider: string;
  model: string;
  runtimeId: string;
  api?: string;
  review?: ProviderRefusalReview;
  nativeThreadId?: string;
  nativeTurnId?: string;
};
