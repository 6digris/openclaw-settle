import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";

export function deferDeviceIdentityDigest() {
  const digest = createDeferred<ArrayBuffer>();
  const digestMock = vi.fn(() => digest.promise);
  vi.stubGlobal("crypto", { subtle: { digest: digestMock } });
  return { digest, digestMock };
}

export function stubInsecureCrypto() {
  // Insecure contexts retain randomness; only crypto.subtle requires a secure context.
  vi.stubGlobal("crypto", {
    randomUUID: () => "req-insecure",
    getRandomValues: (array: Uint8Array) => array.fill(7),
  });
}
