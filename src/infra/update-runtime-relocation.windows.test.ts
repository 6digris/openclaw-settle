import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { relocateRuntimePath } from "./update-runtime-relocation.js";

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});
beforeEach(() => mockProcessPlatform("win32"));
afterEach(() => vi.restoreAllMocks());

const sourceRoot = String.raw`C:\ocu\candidate\wt`;
const destinationRoot = String.raw`D:\openclaw`;
const relative = String.raw`node_modules\.pnpm\yoctocolors@2.2.0\node_modules\yoctocolors`;

describe("Windows runtime junction relocation", () => {
  it.each([false, true])(
    "relocates namespaced targets with namespaced source %s",
    (sourceNamespaced) => {
      const source = sourceNamespaced ? path.toNamespacedPath(sourceRoot) : sourceRoot;
      expect(
        relocateRuntimePath(path.toNamespacedPath(path.join(sourceRoot, relative)), [
          { sourceRoot: source, destinationRoot },
        ]),
      ).toBe(path.join(destinationRoot, relative));
    },
  );

  it("relocates a plain target against a namespaced source without changing case", () => {
    expect(
      relocateRuntimePath(path.join(sourceRoot, "MixedCase", "index.js"), [
        { sourceRoot: path.toNamespacedPath(sourceRoot), destinationRoot },
      ]),
    ).toBe(path.join(destinationRoot, "MixedCase", "index.js"));
  });

  it("preserves external namespace paths", () => {
    const external = String.raw`\\?\C:\external\store\package`;
    expect(relocateRuntimePath(external, [{ sourceRoot, destinationRoot }])).toBe(external);
  });

  it("relocates namespaced UNC junctions using the admitted alias", () => {
    const alias = String.raw`\\server\share\candidate`;
    const target = String.raw`\\?\UNC\server\share\candidate\node_modules\MixedCase`;
    expect(
      relocateRuntimePath(target, [{ sourceRoot, sourceAliases: [alias], destinationRoot }]),
    ).toBe(path.join(destinationRoot, "node_modules", "MixedCase"));
  });
});
