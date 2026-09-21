// In-process authority for the explicit, external-shell update bridge.
// This is not a managed handoff grant and must never cross a process boundary.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";
// In-process authority for the explicit, external-shell update bridge.
// This is not a managed handoff grant and must never cross a process boundary.

export type UpdateBridgeInstallIdentity = Readonly<{
  root: string;
  physicalRoot: string;
  device: string;
  inode: string;
  packageSha256: string;
  buildInfoSha256: string;
}>;

export type UpdateBridgeSelectors = Readonly<{ configPath: string; statePath: string }>;

export type UpdateBridgeRequest = Readonly<{
  target: UpdateBridgeInstallIdentity;
  selectors: UpdateBridgeSelectors;
  bridgeManifestPath: string;
  bridgeManifestSha256: string;
}>;

type BridgeManifest = {
  version: 1;
  root: string;
  sourceCommit: string;
  dependencyLockSha256: string;
  stage1ReceiptSha256: string;
  nodeSha256: string;
  // Complete, independently selected payload inventory. Keep the manifest
  // outside the artifact so it does not need to hash itself.
  files: Record<string, string>;
};

export type AdmittedUpdateBridgeContext = Readonly<{ kind: "update-bridge" }>;
type Binding = {
  target: UpdateBridgeInstallIdentity;
  bridge: UpdateBridgeInstallIdentity;
  modulePath: string;
  entryPath: string;
  manifest: BridgeManifest;
  selectors: UpdateBridgeSelectors;
  selectorParents: readonly string[];
  mutationStarted: boolean;
  nodeIdentity: string;
};
const bindings = new WeakMap<AdmittedUpdateBridgeContext, Binding>();

export function assertExternalUpdateBridgeInvocation(env: NodeJS.ProcessEnv): void {
  const forbidden = Object.keys(env).find(
    (name) =>
      Boolean(env[name]?.trim()) &&
      (/^OPENCLAW_(?:UPDATE_(?:RUN|HANDOFF|POST_CORE|RECOVERY)|POST_CORE_UPDATE)/.test(name) ||
        [
          "OPENCLAW_SERVICE_MARKER",
          "OPENCLAW_SERVICE_KIND",
          "OPENCLAW_GATEWAY_SERVICE_PID",
          "OPENCLAW_LAUNCHD_LABEL",
          "OPENCLAW_WINDOWS_TASK_NAME",
          "OPENCLAW_SUPERVISOR_MODE",
          "LAUNCH_JOB_LABEL",
          "LAUNCH_JOB_NAME",
          "OPENCLAW_SYSTEMD_UNIT",
          "INVOCATION_ID",
          "SYSTEMD_EXEC_PID",
          "JOURNAL_STREAM",
        ].includes(name)),
  );
  if (forbidden || (env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== "0")) {
    throw new Error(
      "Update bridge requires a fresh shell outside Gateway, handoff, and continuation contexts.",
    );
  }
}

/** Refusal-only ancestry inspection. It conveys no maintenance or service authority. */
export function assertExternalUpdateBridgeProcess(): void {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return refuse("external bridge process inspection is unsupported on this platform");
  }
  let pid = process.ppid;
  const seen = new Set<number>();
  while (pid > 1) {
    if (seen.has(pid) || seen.size >= 64) {
      return refuse("process ancestry could not be resolved");
    }
    seen.add(pid);
    const row = execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid=,args="], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(row);
    if (!match) {
      return refuse("process ancestry disappeared during inspection");
    }
    if (/openclaw[- ]gateway|openclaw(?:\.m?js)?\s+gateway(?:\s|$)/i.test(match[2]!)) {
      return refuse("run the bridge outside the Gateway process tree");
    }
    pid = Number(match[1]);
  }
}

function refuse(message: string): never {
  throw new Error(`Update bridge refused: ${message}`);
}

function digest(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) {
      return refuse("payload is not a regular file");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const pathStat = fs.lstatSync(file, { bigint: true });
    if (
      before.dev !== pathStat.dev ||
      before.ino !== pathStat.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      return refuse("payload changed while being read");
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

/** Read-only installation identity; preserve the lexical package-manager root. */
export function readUpdateBridgeInstallIdentity(root: string): UpdateBridgeInstallIdentity {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) {
    return refuse("installation root must be absolute and normalized");
  }
  const physicalRoot = fs.realpathSync(root);
  const stat = fs.statSync(physicalRoot, { bigint: true });
  if (!stat.isDirectory()) {
    return refuse("installation root is not a directory");
  }
  const packageFile = path.join(physicalRoot, "package.json");
  const packageSha256 = digest(packageFile);
  const pkg: unknown = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  if (!pkg || typeof pkg !== "object" || !("name" in pkg) || pkg.name !== "openclaw") {
    return refuse("installation is not an OpenClaw package");
  }
  if (digest(packageFile) !== packageSha256 || fs.realpathSync(root) !== physicalRoot) {
    return refuse("installation changed while being inspected");
  }
  return Object.freeze({
    root,
    physicalRoot,
    device: String(stat.dev),
    inode: String(stat.ino),
    packageSha256,
    buildInfoSha256: digest(path.join(physicalRoot, "dist/build-info.json")),
  });
}

function sameIdentity(
  left: UpdateBridgeInstallIdentity,
  right: UpdateBridgeInstallIdentity,
): boolean {
  return (
    left.root === right.root &&
    left.physicalRoot === right.physicalRoot &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.packageSha256 === right.packageSha256 &&
    left.buildInfoSha256 === right.buildInfoSha256
  );
}

function selectorParentIdentity(selector: string): string {
  if (!path.isAbsolute(selector) || path.resolve(selector) !== selector) {
    return refuse("state/config selectors must be absolute and normalized");
  }
  // Missing state is allowed, but its existing parent may not be retargeted.
  let parent = path.dirname(selector);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) {
      return refuse("selector has no existing ancestor");
    }
    parent = next;
  }
  const stat = fs.statSync(parent, { bigint: true });
  const selected = fs.existsSync(selector) ? fs.statSync(selector, { bigint: true }) : undefined;
  return JSON.stringify([
    parent,
    fs.realpathSync(parent),
    String(stat.dev),
    String(stat.ino),
    selected ? [fs.realpathSync(selector), String(selected.dev), String(selected.ino)] : null,
  ]);
}

function readManifest(filename: string, expected: string): BridgeManifest {
  if (!/^[a-f0-9]{64}$/.test(expected) || digest(filename) !== expected) {
    return refuse("bridge manifest digest does not match the selected artifact");
  }
  if (fs.statSync(filename).size > 16 * 1024 * 1024) {
    return refuse("bridge manifest is too large");
  }
  const value: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (digest(filename) !== expected || !value || typeof value !== "object") {
    return refuse("bridge manifest changed or is invalid");
  }
  // SAFETY: The object remains untrusted; every required field and payload entry is checked below.
  const m = value as Partial<BridgeManifest>;
  if (
    m.version !== 1 ||
    typeof m.root !== "string" ||
    !/^[a-f0-9]{40}$/.test(m.sourceCommit ?? "") ||
    !/^[a-f0-9]{64}$/.test(m.dependencyLockSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(m.stage1ReceiptSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(m.nodeSha256 ?? "") ||
    !m.files ||
    typeof m.files !== "object" ||
    Array.isArray(m.files) ||
    !Object.hasOwn(m.files, "package.json")
  ) {
    return refuse("bridge manifest contract is invalid");
  }
  for (const [name, hash] of Object.entries(m.files)) {
    if (
      !name ||
      name.includes("\\") ||
      name.split("/").some((p) => !p || p === "." || p === "..") ||
      path.isAbsolute(name) ||
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash)
    ) {
      return refuse("bridge manifest has an invalid payload entry");
    }
  }
  // SAFETY: All required manifest fields and file hashes passed the contract checks above.
  return Object.freeze({ ...m, files: Object.freeze({ ...m.files }) }) as BridgeManifest;
}

function nodeIdentity(): string {
  const file = fs.realpathSync(process.execPath);
  const stat = fs.statSync(file, { bigint: true });
  return JSON.stringify([
    file,
    String(stat.dev),
    String(stat.ino),
    String(stat.size),
    String(stat.mtimeNs),
    String(stat.ctimeNs),
  ]);
}

function verifyPayload(binding: Binding): void {
  if (nodeIdentity() !== binding.nodeIdentity) {
    return refuse("Node executable identity changed");
  }
  const { bridge, manifest } = binding;
  if (!sameIdentity(readUpdateBridgeInstallIdentity(bridge.root), bridge)) {
    return refuse("executing bridge identity changed");
  }
  const seen = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile()) {
        const name = path.relative(bridge.physicalRoot, file).split(path.sep).join("/");
        if (!Object.hasOwn(manifest.files, name) || digest(file) !== manifest.files[name]) {
          return refuse("bridge payload differs from the selected inventory");
        }
        seen.add(name);
      } else {
        // A qualified private bridge must close over its dependencies. Shared
        // store links require a separately verified packaging contract.
        return refuse("bridge payload contains a link or special file");
      }
    }
  };
  walk(bridge.physicalRoot);
  if (seen.size !== Object.keys(manifest.files).length) {
    return refuse("bridge payload inventory is incomplete");
  }
  if (!sameIdentity(readUpdateBridgeInstallIdentity(bridge.root), bridge)) {
    return refuse("bridge root changed during payload verification");
  }
  for (const file of [binding.modulePath, binding.entryPath]) {
    if (
      fs.realpathSync(file) !== file ||
      !seen.has(path.relative(bridge.physicalRoot, file).split(path.sep).join("/"))
    ) {
      return refuse("loaded bridge module is outside the selected payload");
    }
  }
}

function current(context: AdmittedUpdateBridgeContext): Binding {
  const binding = bindings.get(context);
  if (!binding) {
    return refuse("context is copied, expired, or was never admitted");
  }
  return binding;
}

/** Read-only admission; only the dedicated entrypoint supplies the actual module URL. */
export function admitUpdateBridgeBinding(
  request: UpdateBridgeRequest,
  actualEntryUrl: string,
): AdmittedUpdateBridgeContext {
  const manifest = readManifest(request.bridgeManifestPath, request.bridgeManifestSha256);
  const target = readUpdateBridgeInstallIdentity(request.target.root);
  if (!sameIdentity(target, request.target)) {
    return refuse("target installation differs from the selected identity");
  }
  const bridge = readUpdateBridgeInstallIdentity(manifest.root);
  if (
    bridge.physicalRoot === target.physicalRoot ||
    bridge.physicalRoot.startsWith(target.physicalRoot + path.sep) ||
    target.physicalRoot.startsWith(bridge.physicalRoot + path.sep)
  ) {
    return refuse("target and executing bridge must be disjoint installations");
  }
  const node = nodeIdentity();
  if (
    digest(fs.realpathSync(process.execPath)) !== manifest.nodeSha256 ||
    nodeIdentity() !== node
  ) {
    return refuse("Node executable differs from the selected bridge manifest");
  }
  const selectors = Object.freeze({ ...request.selectors });
  const binding: Binding = {
    target,
    bridge,
    selectors,
    manifest,
    modulePath: fileURLToPath(import.meta.url),
    entryPath: fileURLToPath(actualEntryUrl),
    selectorParents: [
      selectorParentIdentity(selectors.configPath),
      selectorParentIdentity(selectors.statePath),
    ],
    mutationStarted: false,
    nodeIdentity: node,
  };
  verifyPayload(binding);
  const context = Object.freeze({ kind: "update-bridge" as const });
  bindings.set(context, binding);
  return context;
}

export function resolveBoundUpdateTarget(context: AdmittedUpdateBridgeContext): string {
  const binding = current(context);
  verifyPayload(binding);
  if (
    !binding.mutationStarted &&
    !sameIdentity(readUpdateBridgeInstallIdentity(binding.target.root), binding.target)
  ) {
    return refuse("target installation identity changed");
  }
  return binding.target.root;
}

export function assertBoundUpdateSelectors(
  context: AdmittedUpdateBridgeContext,
  selectors: UpdateBridgeSelectors,
): void {
  const binding = current(context);
  if (
    selectors.configPath !== binding.selectors.configPath ||
    selectors.statePath !== binding.selectors.statePath
  ) {
    return refuse("state/config selection changed");
  }
  if (
    !binding.mutationStarted &&
    [selectors.configPath, selectors.statePath].some(
      (p, i) => selectorParentIdentity(p) !== binding.selectorParents[i],
    )
  ) {
    return refuse("state/config selector parent changed");
  }
}

/** Returns the real owner fence unchanged; never wrap or serialize its authority. */
export async function assertBoundUpdateExecutor(
  context: AdmittedUpdateBridgeContext,
  fence: UpdateRecoveryFence,
  root: string,
): Promise<void> {
  const binding = current(context);
  fence.assertCurrent();
  const { captureUpdateCommandExecutorAuthority } =
    await import("../cli/update-cli/update-command-executor.js");
  const authority = captureUpdateCommandExecutorAuthority(fence);
  if (root !== binding.target.root || authority.installKey !== binding.target.physicalRoot) {
    return refuse("executor belongs to a different installation");
  }
  resolveBoundUpdateTarget(context);
  // The import or payload walk must not outlive the capability or real owner.
  current(context);
  fence.assertCurrent();
}

/** Existing update owners take over target mutation; the old target may then be replaced. */
export async function beginBoundUpdateMutation(
  context: AdmittedUpdateBridgeContext,
  fence: UpdateRecoveryFence,
  root: string,
  resolveSelectors: () => UpdateBridgeSelectors,
): Promise<void> {
  await assertBoundUpdateExecutor(context, fence, root);
  // This owner performs the final check, after executor admission and validation
  // have both yielded. Resolve the caller's environment now, not before either await.
  // Keep the real fence and leave mutationStarted false on every refusal.
  fence.assertCurrent();
  assertBoundUpdateSelectors(context, resolveSelectors());
  current(context).mutationStarted = true;
}

export function releaseUpdateBridgeBinding(context: AdmittedUpdateBridgeContext): void {
  bindings.delete(context);
}

export function bindBridgeExecutor(
  opts: { bridge?: AdmittedUpdateBridgeContext },
  executor: UpdateCommandExecutor,
): UpdateCommandExecutor {
  const context = opts.bridge;
  if (context === undefined) {
    return executor;
  }
  return {
    async enter(root, options) {
      if (root !== resolveBoundUpdateTarget(context)) {
        throw new Error("Update bridge refuses executor retargeting.");
      }
      const fence = await executor.enter(root, options);
      await assertBoundUpdateExecutor(context, fence, root);
      return fence;
    },
  };
}
