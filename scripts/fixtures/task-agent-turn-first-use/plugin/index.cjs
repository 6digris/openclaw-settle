const PLUGIN_ID = "startup-internal-turn-probe";
const MARKER = "OPENCLAW_INTERNAL_TURN_PROBE_OK";

module.exports = {
  id: PLUGIN_ID,
  name: "Task-owned internal agent turn probe",
  register(api) {
    api.registerGatewayMethod(
      "startup-internal-turn-probe.run",
      async ({ params, respond }) => {
        if (!/^[a-z0-9-]{1,80}$/.test(params?.sampleId ?? "")) {
          throw new Error("Invalid task probe sample ID");
        }
        const startedAt = performance.now();
        const accepted = await api.runtime.subagent.run({
          sessionKey: `agent:main:subagent:${PLUGIN_ID}-${params.sampleId}`,
          idempotencyKey: `${PLUGIN_ID}-${params.sampleId}`,
          message: `Return exactly ${MARKER}.`,
          deliver: false,
          promptMode: "minimal",
          disableTools: true,
        });
        const acceptedAt = performance.now();
        const terminal = await api.runtime.subagent.waitForRun({
          runId: accepted.runId,
          timeoutMs: 60_000,
        });
        const terminalAt = performance.now();
        const history = await api.runtime.subagent.getSessionMessages({
          sessionKey: accepted.sessionKey,
          limit: 10,
        });
        respond(true, {
          accepted,
          terminal,
          history,
          timings: {
            acceptanceMs: acceptedAt - startedAt,
            completionMs: terminalAt - startedAt,
            historyReadMs: performance.now() - terminalAt,
          },
        });
      },
      { scope: "operator.admin" },
    );
  },
};
