import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("provider-selected judgments config", () => {
  it.each([{}, { judgments: {} }, { judgments: { provider: "fixture" } }])(
    "accepts optional provider-only configuration: %j",
    (config) => {
      expect(OpenClawSchema.safeParse(config).success).toBe(true);
    },
  );

  it("normalizes the selected provider without adding feature controls", () => {
    const parsed = OpenClawSchema.parse({ judgments: { provider: " fixture " } });
    expect(parsed.judgments).toEqual({ provider: "fixture" });
  });

  it.each(["", "   ", "x".repeat(129), null, false, 7, {}])(
    "rejects an invalid provider selector: %j",
    (provider) => {
      expect(OpenClawSchema.safeParse({ judgments: { provider } }).success).toBe(false);
    },
  );

  it.each([{ unknown: true }, { provider: "fixture", unexpected: true }])(
    "rejects unknown judgment configuration: %j",
    (judgments) => {
      expect(OpenClawSchema.safeParse({ judgments }).success).toBe(false);
    },
  );
});
