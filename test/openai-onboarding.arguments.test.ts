import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Inspect the actual two CLI call sites without running onboarding or using a provider.
describe("default onboarding agent arguments", () => {
  it("exercises local and Gateway first turns without model or thinking overrides", () => {
    const source = readFileSync(
      new URL("./openai-onboarding.live.test.ts", import.meta.url),
      "utf8",
    );
    const calls = [
      ...source.matchAll(/await runOpenClaw\(\s*\[([\s\S]*?)\],\s*state\.env\s*,?\s*\)/gu),
    ]
      .map((match) => match[1] ?? "")
      .filter((args) => /^\s*"agent"\s*,/u.test(args));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('"--local"');
    expect(calls[0]).toContain('"openai-onboarding-live-default"');
    expect(calls[1]).not.toContain('"--local"');
    expect(calls[1]).toContain("gatewaySessionId");
    for (const args of calls) {
      expect(args).toContain('"--agent"');
      expect(args).toContain('"main"');
      expect(args).toContain('"--message"');
      expect(args).toContain('"--json"');
      expect(args).not.toMatch(/"--(?:thinking|model|provider)"/u);
    }
  });
});
