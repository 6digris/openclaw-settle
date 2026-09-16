import { stopTalkRealtimeRelaySession } from "./index.js";
import { drainingRelaySessions } from "./state.js";

/** Tracks this suite's relay sessions and joins their disposal before state resets. */
export function createRelaySessionTestLifecycle() {
  const activeSessions = new Map<string, string>();
  return {
    track(relaySessionId: string, connId: string): void {
      activeSessions.set(relaySessionId, connId);
    },
    stop(params: Parameters<typeof stopTalkRealtimeRelaySession>[0]) {
      const completion = stopTalkRealtimeRelaySession(params);
      activeSessions.delete(params.relaySessionId);
      return completion;
    },
    async drain(): Promise<void> {
      try {
        for (const [relaySessionId, connId] of activeSessions) {
          try {
            await stopTalkRealtimeRelaySession({ relaySessionId, connId });
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.includes("Unknown realtime relay session")
            ) {
              throw error;
            }
          }
        }
        await Promise.all(
          [...drainingRelaySessions].map(
            (session) =>
              session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
          ),
        );
      } finally {
        activeSessions.clear();
      }
    },
  };
}
