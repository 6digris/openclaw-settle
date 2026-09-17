import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getAgentWorkspaceAccess,
  prepareAgentWorkspaceAttachments,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDirList } from "./node-host/dir-list.js";
import { handleFileCreate } from "./node-host/file-create.js";
import { handleFileFetch } from "./node-host/file-fetch.js";
import { handleFileStat } from "./node-host/file-stat.js";
import { handleFileWrite } from "./node-host/file-write.js";
import { createFileTransferNodeInvokePolicy } from "./shared/node-invoke-policy.js";
import { createCtx } from "./shared/node-invoke-policy.test-support.js";
import { registerNodeWorkspaces } from "./workspace-service.js";

vi.mock("./shared/audit.js", () => ({ appendFileTransferAudit: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let local: string;
let remote: string;
let service: OpenClawPluginService;
let api: OpenClawPluginApi;
let nodePolicy: {
  allowReadPaths: string[];
  allowWritePaths: string[];
  followSymlinks: boolean;
  ask: "off";
};
let invoke: ReturnType<typeof vi.fn<OpenClawPluginApi["runtime"]["nodes"]["invoke"]>>;

let openDuplex: OpenClawPluginServiceContext["openNodeDuplex"];
function context() {
  return {
    config: api.config,
    logger: api.logger,
    stateDir: local,
    invokeNode: invoke,
    openNodeDuplex: openDuplex,
  };
}

beforeEach(async () => {
  openDuplex = undefined;
  const parent = await fs.realpath(tempDirs.make("node-workspace-test-"));
  local = path.join(parent, "gateway");
  remote = path.join(parent, "harness");
  await fs.mkdir(local);
  await fs.mkdir(remote);
  await fs.writeFile(path.join(local, "AGENTS.md"), "Gateway decoy");
  await fs.writeFile(path.join(remote, "AGENTS.md"), "Harness instructions");
  nodePolicy = {
    allowReadPaths: [remote, `${remote}/**`],
    allowWritePaths: [`${remote}/AGENTS.md`],
    followSymlinks: false,
    ask: "off",
  };
  const pluginConfig = {
    policyVersion: 2,
    workspaces: { main: { nodeId: "node-1", remoteRoot: remote } },
    nodes: {
      "node-1": nodePolicy,
    },
  };
  invoke = vi.fn(async (request) => {
    expect(request.nodeId).toBe("node-1");
    const { ctx, invokeNode } = createCtx({
      command: request.command,
      params: request.params as Record<string, unknown>,
      pluginConfig,
    });
    invokeNode.mockImplementation(async ({ params } = {}) => {
      switch (request.command) {
        case "file.fetch":
          return {
            ok: true,
            payload: await handleFileFetch(params as Parameters<typeof handleFileFetch>[0]),
          };
        case "file.stat":
          return {
            ok: true,
            payload: await handleFileStat(params as Parameters<typeof handleFileStat>[0]),
          };
        case "file.write":
          return {
            ok: true,
            payload: await handleFileWrite(params as Parameters<typeof handleFileWrite>[0]),
          };
        case "dir.list":
          return {
            ok: true,
            payload: await handleDirList(params as Parameters<typeof handleDirList>[0]),
          };
        default:
          throw new Error(`Unexpected command ${request.command}`);
      }
    });
    const result = await createFileTransferNodeInvokePolicy().handle(ctx);
    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }
    return result;
  });
  api = createTestPluginApi({
    registrationMode: "full",
    config: { plugins: { entries: { "file-transfer": { config: pluginConfig } } } },
    pluginConfig,
    runtime: {
      agent: { resolveAgentWorkspaceDir: () => local },
      nodes: { invoke },
    } as unknown as OpenClawPluginApi["runtime"],
    registerService: (value) => {
      service = value;
    },
  });
  registerNodeWorkspaces(api);
});

afterEach(async () => {
  await service.stop?.(context());
  vi.unstubAllEnvs();
});

describe("registered node workspace service", () => {
  it("allows agents to share the same node workspace", async () => {
    api.config.plugins!.entries!["file-transfer"]!.config = {
      workspaces: {
        main: { nodeId: "node-1", remoteRoot: remote },
        other: { nodeId: "node-1", remoteRoot: `${remote}/.` },
      },
    };
    await service.start(context());
    expect(
      await getAgentWorkspaceAccess(local)!.bridge.readFile({ filePath: "AGENTS.md" }),
    ).toEqual(Buffer.from("Harness instructions"));
  });

  it.each(["node", "root"])("rejects conflicting %s mappings for one workspace", async (kind) => {
    api.config.plugins!.entries!["file-transfer"]!.config = {
      workspaces: {
        main: { nodeId: "node-1", remoteRoot: remote },
        other: {
          nodeId: kind === "node" ? "node-2" : "node-1",
          remoteRoot: kind === "root" ? `${remote}/other` : remote,
        },
      },
    };
    await expect(service.start(context())).rejects.toThrow("Conflicting node workspace mappings");
    expect(() => getAgentWorkspaceAccess(local)).toThrow(/not ready/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "lists POSIX filenames containing backslashes",
    async () => {
      await fs.writeFile(path.join(remote, "draft\\old.txt"), "");
      await service.start(context());
      const entries = await getAgentWorkspaceAccess(local)!.bridge.readDirectory!({
        filePath: ".",
      });
      expect(entries).toEqual([
        { name: "AGENTS.md", isDirectory: false },
        { name: "draft\\old.txt", isDirectory: false },
      ]);
    },
  );

  it("requires service-owned access instead of borrowing the caller's runtime authority", async () => {
    await expect(service.start({ ...context(), invokeNode: undefined })).rejects.toThrow(
      "Gateway service node access",
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(() => getAgentWorkspaceAccess(local)).toThrow(/not ready/);
  });
  it("reads and writes the Harness workspace through existing policy and commands", async () => {
    expect(() => getAgentWorkspaceAccess(local)).toThrow(/not ready/);
    await service.start(context());
    const access = getAgentWorkspaceAccess(local)!;
    const filePath = path.join(local, "AGENTS.md");
    expect(await access.bridge.readFileWithSource!({ filePath })).toEqual({
      data: Buffer.from("Harness instructions"),
      canonicalPath: path.join(remote, "AGENTS.md"),
      workspaceRelativePath: "AGENTS.md",
    });
    expect(await access.bridge.stat({ filePath })).toMatchObject({ type: "file", size: 20 });
    expect(await access.bridge.stat({ filePath: path.join(local, "missing") })).toBeNull();
    await expect(access.bridge.readFile({ filePath: "missing" })).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await access.bridge.readDirectory!({ filePath: local })).toEqual([
      { name: "AGENTS.md", isDirectory: false },
    ]);
    await access.bridge.writeFile({ filePath, data: "Live owner edit" });
    expect(await fs.readFile(path.join(remote, "AGENTS.md"), "utf8")).toBe("Live owner edit");
    expect(await fs.readFile(filePath, "utf8")).toBe("Gateway decoy");
  });

  it("does not turn workspace placement into a broader write grant", async () => {
    await service.start(context());
    const bridge = getAgentWorkspaceAccess(local)!.bridge;
    await expect(bridge.writeFile({ filePath: "project.txt", data: "denied" })).rejects.toThrow();
    expect(await fs.readdir(remote)).toEqual(["AGENTS.md"]);
    invoke.mockClear();
    await expect(bridge.readFile({ filePath: "../outside" })).rejects.toThrow(/outside/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("lists a workspace directory across node result pages", async () => {
    for (let start = 0; start < 4100; start += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) =>
          fs.writeFile(path.join(remote, `${String(start + offset).padStart(4, "0")}.txt`), ""),
        ),
      );
    }
    await service.start(context());
    const entries = await getAgentWorkspaceAccess(local)!.bridge.readDirectory!({ filePath: "." });
    expect(entries).toHaveLength(4101);
    expect(new Set(entries.map((entry) => entry.name))).toEqual(new Set(await fs.readdir(remote)));
    expect(entries).toContainEqual({ name: "AGENTS.md", isDirectory: false });
  });

  it("rejects a directory continuation that makes no progress", async () => {
    await service.start(context());
    invoke.mockResolvedValue({
      payload: { ok: true, path: remote, entries: [], truncated: true, nextPageToken: "0" },
    });
    await expect(
      getAgentWorkspaceAccess(local)!.bridge.readDirectory!({ filePath: "." }),
    ).rejects.toThrow("Invalid dir.list continuation");
  });

  it("preserves bootstrap reads through in-workspace parent aliases", async () => {
    const nested = path.join(remote, "nested");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, "MEMORY.md"), "Nested memory");
    await fs.symlink(nested, path.join(remote, "alias"), "dir");
    nodePolicy.followSymlinks = true;
    await service.start(context());
    const bridge = getAgentWorkspaceAccess(local)!.bridge;
    expect(await bridge.readFileWithSource!({ filePath: "alias/MEMORY.md" })).toEqual({
      data: Buffer.from("Nested memory"),
      canonicalPath: path.join(nested, "MEMORY.md"),
      workspaceRelativePath: "nested/MEMORY.md",
    });
    await fs.symlink(remote, path.join(remote, "root-alias"), "dir");
    expect(await bridge.readFileWithSource!({ filePath: "root-alias/AGENTS.md" })).toMatchObject({
      canonicalPath: path.join(remote, "AGENTS.md"),
      workspaceRelativePath: "AGENTS.md",
    });
    // Ordinary document access keeps its stricter no-alias behavior.
    await expect(bridge.readFile({ filePath: "alias/MEMORY.md" })).rejects.toThrow();
  });

  it.each(["outside", "leaf", "policy"])(
    "does not expand bootstrap reads through a %s alias",
    async (kind) => {
      nodePolicy.followSymlinks = kind !== "policy";
      const outside = await fs.realpath(tempDirs.make("node-workspace-read-outside-"));
      await fs.writeFile(path.join(outside, "AGENTS.md"), "Outside instructions");
      // Even a broader node grant must not let the workspace reader escape.
      nodePolicy.allowReadPaths.push(`${outside}/**`);
      const target = kind === "outside" ? outside : remote;
      const alias = path.join(remote, "alias");
      const filePath = kind === "leaf" ? "alias" : "alias/AGENTS.md";
      await fs.symlink(kind === "leaf" ? path.join(remote, "AGENTS.md") : target, alias);
      await service.start(context());
      await expect(
        getAgentWorkspaceAccess(local)!.bridge.readFileWithSource!({ filePath }),
      ).rejects.toThrow();
    },
  );

  it.each(["parent", "root"])(
    "rejects a symlinked %s before writing outside the workspace",
    async (kind) => {
      const outside = await fs.realpath(tempDirs.make("node-workspace-outside-"));
      const target = path.join(outside, "AGENTS.md");
      await fs.writeFile(target, "Outside instructions");
      nodePolicy.followSymlinks = true;
      nodePolicy.allowWritePaths = [`${remote}/**`, `${outside}/**`];
      let filePath = "redirect/AGENTS.md";
      if (kind === "root") {
        await fs.rename(remote, `${remote}-original`);
        await fs.symlink(outside, remote);
        filePath = "AGENTS.md";
      } else {
        await fs.symlink(outside, path.join(remote, "redirect"));
      }
      await service.start(context());
      await expect(
        getAgentWorkspaceAccess(local)!.bridge.writeFile({ filePath, data: "Must not write" }),
      ).rejects.toThrow();
      expect(await fs.readFile(target, "utf8")).toBe("Outside instructions");
    },
  );

  it("keeps byte limits and returns no local fallback after service shutdown", async () => {
    await service.start(context());
    const bridge = getAgentWorkspaceAccess(local)!.bridge;
    await expect(bridge.readFile({ filePath: "AGENTS.md", maxBytes: 4 })).rejects.toThrow(
      /FILE_TOO_LARGE/,
    );
    await service.stop?.(context());
    invoke.mockClear();
    await expect(bridge.readFile({ filePath: "AGENTS.md" })).rejects.toThrow(/stopped/);
    expect(() => getAgentWorkspaceAccess(local)).toThrow(/not ready/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels an in-flight request when the service stops", async () => {
    await service.start(context());
    const response = createDeferred<unknown>();
    invoke.mockImplementationOnce(async () => response.promise);
    const pending = getAgentWorkspaceAccess(local)!.bridge.readFile({ filePath: "AGENTS.md" });
    const signal = invoke.mock.calls[0]?.[0]?.signal;
    await service.stop?.(context());
    expect(signal?.aborted).toBe(true);
    response.resolve({ payload: {} });
    await expect(pending).rejects.toThrow(/stopped/);
  });
});

/** Real policy and file handlers; only the paired connection is replaced here. */
function enableAttachmentTransport(afterChunk?: () => void) {
  openDuplex = async (request) => {
    const controller = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([controller.signal, request.signal])
      : controller.signal;
    const ready = createDeferred<void>();
    let receive: ((message: Uint8Array) => void | Promise<void>) | undefined;
    let acknowledge: ((message: Uint8Array) => void | Promise<void>) | undefined;
    const io: OpenClawPluginNodeHostCommandIo = {
      signal,
      emitChunk: async () => {},
      onInput: () => {},
      frames: {
        onMessage: (listener) => {
          receive = listener;
          ready.resolve();
          return () => {
            receive = undefined;
          };
        },
        send: async (message) => {
          await acknowledge?.(message);
        },
      },
    };
    const { ctx, invokeNode } = createCtx({
      command: request.command,
      params: request.params as Record<string, unknown>,
      pluginConfig: api.config.plugins!.entries!["file-transfer"]!.config,
    });
    invokeNode.mockImplementation(async ({ params } = {}) => {
      request.assertCurrent?.();
      signal.throwIfAborted();
      return { ok: true, payload: await handleFileCreate(params as Record<string, unknown>, io) };
    });
    const closed = createFileTransferNodeInvokePolicy()
      .handle(ctx)
      .then((result) => {
        if (!result.ok) {
          throw new Error(`${result.code}: ${result.message}`);
        }
        return result;
      });
    await Promise.race([
      ready.promise,
      closed.then(() => {
        throw new Error("closed before upload ready");
      }),
    ]);
    return {
      send: async (message) => {
        request.assertCurrent?.();
        signal.throwIfAborted();
        if (!receive) {
          throw new Error("input receiver missing");
        }
        await receive(message);
        if (message.byteLength) {
          afterChunk?.();
        }
      },
      onMessage: (listener) => {
        acknowledge = listener;
        return () => {
          acknowledge = undefined;
        };
      },
      close: () => controller.abort(new Error("test connection closed")),
      closed,
    };
  };
}

async function attachmentInput(sizeMiB: number) {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(local, "state"));
  const bytes = Buffer.alloc(sizeMiB * 1024 * 1024, 0x6d);
  const saved = await saveMediaBuffer(
    bytes,
    "application/octet-stream",
    "inbound",
    bytes.length,
    "report.bin",
  );
  expect(saved.path.startsWith(local + path.sep)).toBe(true);
  const inputDirectory = `media/inbound/openclaw-staged-${createHash("sha256").update(saved.path).digest("hex")}`;
  const target = path.join(remote, inputDirectory, `input-${path.basename(saved.path)}`);
  nodePolicy.allowReadPaths = [
    `${remote}/AGENTS.md`,
    `${remote}/media/inbound/openclaw-staged-*`,
    `${remote}/media/inbound/openclaw-staged-*/**`,
  ];
  nodePolicy.allowWritePaths.push(`${remote}/media/inbound/openclaw-staged-*/**`);
  return { bytes, target, turn: { media: [{ path: saved.path }], timeoutMs: 60_000 } };
}

describe("node workspace attachment caller", () => {
  it.each([17, 50])(
    "transfers %i MiB through registered access and retains Harness edits",
    async (size) => {
      const input = await attachmentInput(size);
      enableAttachmentTransport();
      await service.start(context());
      const params = { workspaceDir: local, turn: input.turn, assertCurrent: () => {} };
      const original = JSON.stringify(input.turn);
      const note = await prepareAgentWorkspaceAttachments(params);
      expect(note).toBe(`[media attached: ${input.target}]`);
      expect(
        createHash("sha256")
          .update(await fs.readFile(input.target))
          .digest("hex"),
      ).toBe(createHash("sha256").update(input.bytes).digest("hex"));
      expect(JSON.stringify(input.turn)).toBe(original);
      expect(await fs.readFile(path.join(local, "AGENTS.md"), "utf8")).toBe("Gateway decoy");
      await expect(fs.stat(path.join(local, "media"))).rejects.toMatchObject({ code: "ENOENT" });
      await fs.writeFile(input.target, "Harness edit");
      expect(await prepareAgentWorkspaceAttachments(params)).toBe(note);
      expect(await fs.readFile(input.target, "utf8")).toBe("Harness edit");
    },
  );

  it("requires explicit input-path permission without widening owner document writes", async () => {
    const input = await attachmentInput(1);
    nodePolicy.allowWritePaths = [`${remote}/AGENTS.md`];
    enableAttachmentTransport();
    await service.start(context());
    await expect(
      prepareAgentWorkspaceAttachments({
        workspaceDir: local,
        turn: input.turn,
        assertCurrent: () => {},
      }),
    ).rejects.toThrow();
    expect(await fs.readdir(remote)).toEqual(["AGENTS.md"]);
  });

  it("revokes a turn during transfer without publishing partial input", async () => {
    const input = await attachmentInput(17);
    let current = true;
    enableAttachmentTransport(() => {
      current = false;
    });
    await service.start(context());
    await expect(
      prepareAgentWorkspaceAttachments({
        workspaceDir: local,
        turn: input.turn,
        assertCurrent() {
          if (!current) {
            throw new Error("turn ended");
          }
        },
      }),
    ).rejects.toThrow("turn ended");
    await expect(fs.stat(input.target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
