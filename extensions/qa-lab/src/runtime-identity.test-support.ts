import { onTestFinished } from "vitest";

export function stubBunVersion(version: string | undefined) {
  const versions = process.versions;
  const original = Object.getOwnPropertyDescriptor(versions, "bun");
  onTestFinished(() => {
    if (original) {
      Object.defineProperty(versions, "bun", original);
    } else {
      Reflect.deleteProperty(versions, "bun");
    }
  });
  // Keep the real process and its inherited lifecycle methods available to fixtures.
  Object.defineProperty(versions, "bun", { configurable: true, value: version });
}
