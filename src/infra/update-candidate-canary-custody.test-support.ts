import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import { stubHealthyGateway } from "./update-candidate-canary.test-support.js";

export function registerCanaryWriterCustodyTests(params: {
  setContract(contract: unknown): void;
  options(): Parameters<typeof validateUpdateCandidateCanary>[0];
  spawnedGateway(): boolean;
}) {
  it.each([undefined, "unknown", "native-pins-v1"])(
    "requires transferable writer custody before live cutover (%s)",
    async (writerCustody) => {
      params.setContract({ state: 2, agent: 3, writerCustody });
      stubHealthyGateway();
      const result = await validateUpdateCandidateCanary({
        ...params.options(),
        requireWriterCustody: true,
      });
      const supported = writerCustody === "native-pins-v1";
      expect(result.status).toBe(supported ? "ok" : "error");
      expect(result.phase).toBe(supported ? "readiness" : "runtime");
      expect(params.spawnedGateway()).toBe(supported);
    },
  );
  it("refuses live cutover when the candidate has no custody-capable finalizer", async () => {
    const options = params.options();
    await fs.rm(path.join(options.root, "dist/infra/update-migrated-finalize.worker.js"));
    const result = await validateUpdateCandidateCanary({ ...options, requireWriterCustody: true });
    expect(result).toMatchObject({ status: "error", phase: "runtime" });
    expect(params.spawnedGateway()).toBe(false);
  });
}
