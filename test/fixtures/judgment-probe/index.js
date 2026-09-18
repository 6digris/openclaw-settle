// Synthetic-only registered provider used by isolated Gateway behavioral proofs.
import { createHash } from "node:crypto";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
export default {
  id: "judgment-probe",
  register(api) {
    let started = 0;
    let settled = 0;
    const credential = () => getPreparedPluginSecretInput("judgment-probe", "apiKey");
    api.registerJudgmentProvider({
      id: "synthetic",
      contractVersion: 1,
      isReady: () => Boolean(credential().value),
      async evaluate(batch, { signal }) {
        started++;
        try {
          if (batch.state?.mode === "hang") {
            await new Promise((resolve) => {
              signal.addEventListener("abort", resolve, { once: true });
            });
          }
          signal.throwIfAborted();
          if (batch.state?.mode === "auth") {
            return { status: "unavailable", reason: "authentication" };
          }
          if (batch.state?.mode === "outage") {
            return { status: "unavailable", reason: "transport" };
          }
          const key = credential().value;
          if (!key) {
            return { status: "unavailable", reason: "credentials-unavailable" };
          }
          const tag = createHash("sha256").update(key).digest("hex").slice(0, 8);
          return {
            status: "ok",
            result: {
              model: `synthetic-${tag}`,
              answers: { check: { type: "boolean", probabilityTrue: 1 } },
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
        } finally {
          settled++;
        }
      },
    });
    api.registerGatewayMethod(
      "judgment.probe",
      async ({ params, respond }) => {
        if (params.stats) {
          respond(true, { started, settled, revision: credential().revision });
          return;
        }
        try {
          const result = await api.runtime.judgments.evaluate(
            {
              state: { mode: params.mode ?? "ok" },
              questions: { check: { type: "boolean", instructions: "Synthetic contract probe" } },
            },
            {
              purpose: "synthetic.probe",
              rubricVersion: "fixture-v1",
              timeoutMs: 5000,
              signal: new AbortController().signal,
            },
          );
          respond(true, { result, started, settled });
        } catch {
          respond(true, { closed: true, started, settled });
        }
      },
      { scope: "operator.admin" },
    );
  },
};
