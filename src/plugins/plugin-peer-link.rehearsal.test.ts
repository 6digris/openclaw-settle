import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDoctorRehearsalWriteGuard } from "../commands/doctor/shared/rehearsal-write-scope.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { linkOpenClawPeerDependencies } from "./plugin-peer-link.js";

let root: string;
let privateRoot: string;
let hostRoot: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-d12-destination-"));
  privateRoot = path.join(root, "private");
  hostRoot = path.join(privateRoot, "host");
  await fs.mkdir(hostRoot, { recursive: true });
  env = {
    ...buildUpdateRehearsalPathEnv(privateRoot),
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
  };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it.each(["missing-modules", "missing-link", "stale-link", "package-copy", "ancestor-link"])(
  "refuses an outside %s destination without modifying it",
  async (layout) => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    const modules = path.join(outside, "node_modules");
    const link = path.join(modules, "openclaw");
    if (layout !== "missing-modules") {
      await fs.mkdir(modules);
    }
    if (layout === "stale-link") {
      await fs.symlink(hostRoot + "-old", link, "junction");
    }
    if (layout === "package-copy") {
      await fs.mkdir(link);
      await fs.writeFile(path.join(link, "package.json"), '{"name":"openclaw"}');
    }
    let installedDir = outside;
    if (layout === "ancestor-link") {
      installedDir = path.join(privateRoot, "linked-plugin");
      await fs.symlink(outside, installedDir, "junction");
    }
    const guard = createDoctorRehearsalWriteGuard(env);
    expect(guard).toBeTypeOf("function");
    await expect(
      linkOpenClawPeerDependencies({
        installedDir,
        hostRoot,
        peerDependencies: { openclaw: "*" },
        logger: {},
        beforePersistentApply: guard,
      }),
    ).rejects.toThrow("destination escapes");
    if (layout === "missing-modules") {
      await expect(fs.lstat(modules)).rejects.toMatchObject({ code: "ENOENT" });
    } else if (layout === "stale-link") {
      expect(await fs.readlink(link)).toBe(hostRoot + "-old");
    } else if (layout === "package-copy") {
      expect(await fs.readFile(path.join(link, "package.json"), "utf8")).toBe(
        '{"name":"openclaw"}',
      );
    } else {
      await expect(fs.lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

it("allows the private destination and checks current authority after async preparation", async () => {
  const installedDir = path.join(privateRoot, "plugin");
  await fs.mkdir(installedDir);
  const events: string[] = [];
  const guard = createDoctorRehearsalWriteGuard(env);
  const result = await linkOpenClawPeerDependencies({
    installedDir,
    hostRoot,
    peerDependencies: { openclaw: "*" },
    logger: {},
    beforePersistentEffect: async () => {
      events.push("prepare");
    },
    beforePersistentApply: (destination) => {
      events.push("assert");
      guard?.(destination);
    },
  });
  expect(result.repaired).toBe(1);
  expect(events).toEqual(["prepare", "assert", "prepare", "assert"]);
  expect(await fs.realpath(path.join(installedDir, "node_modules/openclaw"))).toBe(
    await fs.realpath(hostRoot),
  );
});
