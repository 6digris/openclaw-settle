import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveConfigPath } from "../config/paths.js";
import type * as Binding from "../infra/update-bridge-binding.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "./update-cli/update-command-executor.js";
const coordinator = vi.hoisted(() => vi.fn<() => string>());
vi.mock("../infra/tmp-openclaw-dir.js", async (original) => ({
  ...(await original<typeof import("../infra/tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: coordinator,
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const base = dirs.make("bridge-transition-");
  const bridge = path.join(base, "bridge");
  const target = path.join(base, "target");
  for (const root of [bridge, target]) {
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","type":"module"}');
    fs.writeFileSync(path.join(root, "dist/build-info.json"), '{"commit":"fixture"}');
  }
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: path.join(base, "profile/config.json"),
    OPENCLAW_STATE_DIR: path.join(base, "state"),
  };
  const selectors = () => ({
    configPath: resolveConfigPath(env),
    statePath: resolveOpenClawStateSqlitePath(env),
  });
  for (const file of Object.values(selectors())) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "unchanged-selector");
  }
  fs.mkdirSync(path.join(base, "coordinator"));
  coordinator.mockReturnValue(path.join(base, "coordinator"));
  const ready = deferred();
  const resume = deferred();
  const hookKey = randomUUID();
  const hook = Symbol.for(hookKey);
  Object.defineProperty(globalThis, hook, {
    configurable: true,
    value: {
      capture: captureUpdateCommandExecutorAuthority,
      ready: ready.resolve,
      wait: resume.promise,
    },
  });
  const bindingFile = path.join(bridge, "dist/update-bridge-binding.js");
  fs.mkdirSync(path.join(bridge, "cli/update-cli"), { recursive: true });
  fs.writeFileSync(
    bindingFile,
    ts.transpileModule(
      fs.readFileSync(new URL("../infra/update-bridge-binding.ts", import.meta.url), "utf8"),
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
    ).outputText,
  );
  // Only the import scheduling seam is synthetic. Capture and fence remain the
  // real executor's WeakMap capability; no substitute fence/authority is created.
  fs.writeFileSync(
    path.join(bridge, "cli/update-cli/update-command-executor.js"),
    `
    const hook = globalThis[Symbol.for(${JSON.stringify(hookKey)})];
    hook.ready(); await hook.wait;
    export const captureUpdateCommandExecutorAuthority = (fence) => hook.capture(fence);
  `,
  );
  const entry = path.join(bridge, "dist/entry.js");
  fs.writeFileSync(entry, "export {};\n");
  const b: typeof Binding = await import(/* @vite-ignore */ pathToFileURL(bindingFile).href);
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(file);
      } else {
        files[path.relative(bridge, file).split(path.sep).join("/")] = hash(fs.readFileSync(file));
      }
    }
  };
  walk(bridge);
  const manifest = path.join(base, "manifest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      root: bridge,
      sourceCommit: "a".repeat(40),
      dependencyLockSha256: "b".repeat(64),
      stage1ReceiptSha256: "c".repeat(64),
      nodeSha256: hash(fs.readFileSync(process.execPath)),
      files,
    }),
  );
  const context = b.admitUpdateBridgeBinding(
    {
      target: b.readUpdateBridgeInstallIdentity(target),
      selectors: selectors(),
      bridgeManifestPath: manifest,
      bridgeManifestSha256: hash(fs.readFileSync(manifest)),
    },
    pathToFileURL(entry).href,
  );
  return { b, base, target, context, selectors, env, ready, resume, hook };
}

for (const phase of ["enter", "validate"] as const) {
  it.each([
    "config-parent",
    "state-parent",
    "config-file",
    "state-file",
    "environment",
    "unchanged",
  ])(`refuses swapped selector across ${phase} await; %s`, async (fault) => {
    const f = await fixture();
    const entered = deferred();
    const continueEnter = deferred();
    let effects = 0;
    const selected = f.selectors();
    try {
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const transition = (async () => {
          const fence = await executor.enter(f.target, { preflight: true });
          // Preserve the actual fence; postpone its return from executor admission.
          if (phase === "enter") {
            entered.resolve();
            await continueEnter.promise;
          }
          await f.b.beginBoundUpdateMutation(f.context, fence, f.target, f.selectors);
          effects++;
        })();
        const result = transition.then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
        if (phase === "enter") {
          await entered.promise;
        } else {
          await f.ready.promise;
        }
        if (fault === "environment") {
          f.env.OPENCLAW_CONFIG_PATH += ".other";
        } else if (fault !== "unchanged") {
          const file = fault.startsWith("config") ? selected.configPath : selected.statePath;
          const swap = fault.endsWith("parent") ? path.dirname(file) : file;
          fs.renameSync(swap, swap + ".before");
          if (fault.endsWith("parent")) {
            fs.mkdirSync(swap);
            fs.copyFileSync(path.join(swap + ".before", path.basename(file)), file);
          } else {
            fs.copyFileSync(swap + ".before", file);
          }
        }
        continueEnter.resolve();
        f.resume.resolve();
        const settled = await result;
        if (fault === "unchanged") {
          expect(settled.error).toBeUndefined();
          expect(effects).toBe(1);
          // Legitimate post-start selector inode replacement remains permitted.
          fs.renameSync(selected.configPath, selected.configPath + ".after-start");
          fs.writeFileSync(selected.configPath, "legitimate update");
          fs.renameSync(
            path.dirname(selected.statePath),
            path.dirname(selected.statePath) + ".after-start",
          );
          fs.mkdirSync(path.dirname(selected.statePath));
          fs.writeFileSync(selected.statePath, "legitimate state publication");
          fs.renameSync(f.target, f.target + ".after-start");
          fs.cpSync(f.target + ".after-start", f.target, { recursive: true });
          expect(() => f.b.assertBoundUpdateSelectors(f.context, selected)).not.toThrow();
          expect(f.b.resolveBoundUpdateTarget(f.context)).toBe(f.target);
        } else {
          expect(settled.error).toBeInstanceOf(Error);
          expect(effects).toBe(0);
          // A physical swap is still rejected: mutationStarted was not flipped.
          if (fault !== "environment") {
            expect(() => f.b.assertBoundUpdateSelectors(f.context, selected)).toThrow(
              /parent changed/,
            );
          }
          expect(fs.existsSync(path.join(f.target, "effect.json"))).toBe(false);
          expect(fs.readdirSync(f.target).toSorted()).toEqual(["dist", "package.json"]);
          for (const file of Object.values(selected)) {
            expect(fs.readFileSync(file, "utf8")).toBe("unchanged-selector");
          }
        }
      });
    } finally {
      continueEnter.resolve();
      f.resume.resolve();
      f.b.releaseUpdateBridgeBinding(f.context);
      Reflect.deleteProperty(globalThis, f.hook);
    }
  });
}

it.each(["enter", "validate"] as const)(
  "refuses mutation after executor cancellation during %s await",
  async (phase) => {
    const f = await fixture();
    const entered = deferred();
    const continueEnter = deferred();
    let effects = 0;
    let result: Promise<{ error: unknown }> | undefined;
    try {
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const transition = (async () => {
          const fence = await executor.enter(f.target, { preflight: true });
          if (phase === "enter") {
            entered.resolve();
            await continueEnter.promise;
          }
          await f.b.beginBoundUpdateMutation(f.context, fence, f.target, f.selectors);
          effects++;
        })();
        result = transition.then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
        if (phase === "enter") {
          await entered.promise;
        } else {
          await f.ready.promise;
        }
        // Finish the real executor scope while the attempted transition is held.
        // Its real lease and WeakMap authority expire; no fake fence is supplied.
      });
      continueEnter.resolve();
      f.resume.resolve();
      const settled = await result!;
      expect(settled.error).toBeInstanceOf(Error);
      expect((settled.error as Error).message).toMatch(/ownership is no longer current/);
      expect(effects).toBe(0);
      for (const file of Object.values(f.selectors())) {
        expect(fs.readFileSync(file, "utf8")).toBe("unchanged-selector");
      }
      expect(fs.readdirSync(f.target).toSorted()).toEqual(["dist", "package.json"]);
      // A later physical replacement must still be rejected: cancellation did
      // not cross the binding's mutationStarted transition.
      const selected = f.selectors();
      fs.renameSync(selected.configPath, selected.configPath + ".after-cancel");
      fs.writeFileSync(selected.configPath, "unchanged-selector");
      expect(() => f.b.assertBoundUpdateSelectors(f.context, selected)).toThrow(/parent changed/);
    } finally {
      continueEnter.resolve();
      f.resume.resolve();
      await result;
      f.b.releaseUpdateBridgeBinding(f.context);
      Reflect.deleteProperty(globalThis, f.hook);
    }
  },
);
