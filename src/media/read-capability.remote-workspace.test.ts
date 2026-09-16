import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SandboxFsBridge } from "../agents/sandbox/fs-bridge.types.js";
import { registerAgentWorkspaceAccess } from "../agents/workspace-access.js";
import { readOutboundMediaFile } from "./bounded-read-file.js";
import { buildOutboundMediaLoadOptions } from "./load-options.js";
import { resolveOutboundAttachmentFromUrl } from "./outbound-attachment.js";
import { resolveAgentScopedOutboundMediaAccess } from "./read-capability.js";
import { loadWebMediaRaw } from "./web-media.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-outbound-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  const gateway = path.join(root, "gateway");
  const remote = path.join(root, "harness", "media", "outbound");
  const mirrored = path.join(gateway, "media", "outbound");
  await fs.mkdir(remote, { recursive: true });
  await fs.mkdir(mirrored, { recursive: true });
  const file = path.join(remote, "result.txt");
  await fs.writeFile(file, "fresh Harness output\n");
  await fs.writeFile(path.join(mirrored, "result.txt"), "stale Gateway output\n");
  const deny = () => {
    throw new Error("owner-document bridge must not serve attachments");
  };
  const bridge: SandboxFsBridge = {
    resolvePath: deny,
    readFile: deny,
    writeFile: deny,
    mkdirp: deny,
    remove: deny,
    rename: deny,
    stat: deny,
  };
  const readFile = vi.fn(async (filePath: string, maxBytes: number) => {
    const bytes = await fs.readFile(path.join(remote, path.basename(filePath)));
    if (bytes.length > maxBytes) {
      throw new Error("attachment byte limit");
    }
    return bytes;
  });
  const release = registerAgentWorkspaceAccess(gateway, {
    bridge,
    outboundMedia: { localRoots: [remote, mirrored], readFile },
  });
  cleanups.push(release);
  const resolve = (source: string) =>
    resolveAgentScopedOutboundMediaAccess({
      cfg: { agents: { defaults: { workspace: gateway } }, tools: { fs: { workspaceOnly: true } } },
      agentId: "main",
      workspaceDir: gateway,
      mediaSources: [source],
    });
  return { root, gateway, remote, mirrored, file, readFile, release, resolve };
}

it("stages the remote attachment into Gateway media without reading its stale mirror", async () => {
  const f = await fixture();
  const source = path.join(f.mirrored, "result.txt");
  const saved = await resolveOutboundAttachmentFromUrl(source, 1024, {
    mediaAccess: f.resolve(source),
  });
  expect(await fs.readFile(saved.path, "utf8")).toBe("fresh Harness output\n");
  expect(f.readFile).toHaveBeenCalledWith(source, expect.any(Number));
  f.release();
  const cached = await loadWebMediaRaw(
    saved.path,
    buildOutboundMediaLoadOptions({ mediaAccess: f.resolve(saved.path) }),
  );
  expect(cached.buffer.toString()).toBe("fresh Harness output\n");
});

it("accepts the Harness path and enforces the caller's byte limit", async () => {
  const f = await fixture();
  const access = f.resolve(f.file);
  const loaded = await loadWebMediaRaw(
    f.file,
    buildOutboundMediaLoadOptions({ maxBytes: 1024, mediaAccess: access }),
  );
  expect(loaded.buffer.toString()).toBe("fresh Harness output\n");
  await expect(readOutboundMediaFile(access.readFile!, f.file, { maxBytes: 1 })).rejects.toThrow(
    "attachment byte limit",
  );
});

it("refuses stale workspace files outside the declared attachment roots", async () => {
  const f = await fixture();
  const privateFile = path.join(f.gateway, "AGENTS.md");
  await fs.writeFile(privateFile, "Gateway decoy");
  await expect(
    loadWebMediaRaw(
      privateFile,
      buildOutboundMediaLoadOptions({ mediaAccess: f.resolve(privateFile) }),
    ),
  ).rejects.toThrow();
  expect(f.readFile).not.toHaveBeenCalled();
});

it("rejects an attachment whose binding is revoked during its read", async () => {
  const f = await fixture();
  const access = f.resolve(f.file);
  f.readFile.mockImplementationOnce(async () => {
    f.release();
    return Buffer.from("must not escape");
  });
  await expect(readOutboundMediaFile(access.readFile!, f.file, { maxBytes: 1024 })).rejects.toThrow(
    /stopped|changed/,
  );
  expect(() => f.resolve(f.file)).toThrow(/stopped/);
});
