import { describe, expect, it } from "vitest";
import * as actualConfig from "../config/config.js";
import { createGatewayConfigModuleMock } from "./test-helpers.config-runtime.js";

describe("gateway test config runtime", () => {
  const configMock = createGatewayConfigModuleMock(actualConfig);

  it("disables the audit worker by default", () => {
    expect(configMock.applyConfigOverrides({}).audit).toEqual({ enabled: false });
  });

  it("preserves an explicit audit configuration", () => {
    expect(configMock.applyConfigOverrides({ audit: { enabled: true } }).audit).toEqual({
      enabled: true,
    });
  });
});
