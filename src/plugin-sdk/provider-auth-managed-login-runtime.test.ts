import { describe, expect, it } from "vitest";
import { runManagedModelsAuthLoginFlow } from "./provider-auth-managed-login-runtime.js";

describe("managed provider auth login runtime facade", () => {
  it("rejects calls without the managed capability before loading the command runtime", async () => {
    await expect(runManagedModelsAuthLoginFlow({} as never)).rejects.toThrow(
      "Managed auth login requires the supported managed login capability marker.",
    );
  });
});
