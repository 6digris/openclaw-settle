import { expect, it } from "vitest";
import { startAutomationProvider } from "./control-ui-automation-management.test-support.js";

it.each([false, true])(
  "keeps the admin run reply open while scheduled work completes (stream: %s)",
  async (stream) => {
    const provider = await startAutomationProvider();
    const result = JSON.stringify({ ok: true, enqueued: true });
    provider.requests.set("admin-run", { action: "run", jobId: "synthetic-job" });
    const post = (input: unknown[]) =>
      fetch(`${provider.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream, input }),
      });
    let replied = false;
    const adminReply = post([
      { role: "user", content: "Run the reminder. [automation-proof:admin-run]" },
      { type: "function_call_output", call_id: "run-call", output: result },
    ]).then(async (response) => {
      const text = await response.text();
      replied = true;
      return text;
    });
    try {
      await expect.poll(() => provider.results.get("admin-run")).toBe(result);
      const scheduled = await post([{ role: "user", content: "Complete the scheduled reminder." }]);
      expect(await scheduled.text()).toContain("Scheduled reminder completed.");
      expect(replied).toBe(false);

      provider.releaseRunReply();
      expect(await adminReply).toContain("admin-run:");
      expect(replied).toBe(true);
    } finally {
      provider.releaseRunReply();
      try {
        await adminReply;
      } finally {
        await provider.stop();
      }
    }
  },
);
