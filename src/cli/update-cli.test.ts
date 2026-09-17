import { describe } from "vitest";
import { defineUpdateCliSuite } from "./update-cli.test-support.js";

const { registerUpdateCliFinalizationTests } = await import("./update-cli.finalization.suite.js");

describe("update-cli", () => {
  const fixtures = defineUpdateCliSuite();
  registerUpdateCliFinalizationTests(() => fixtures);
});
