import { AsyncLocalStorage } from "node:async_hooks";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

it.each(["initial", "closed", "disabled", "evicted"] as const)(
  "reads repaired skills immediately after %s watcher acquisition",
  async (lifecycle) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-acquire-")));
    const workspaceDir = path.join(root, "workspace");
    const skillDir = path.join(workspaceDir, "skills", "acquire-proof");
    const skillFile = path.join(skillDir, "SKILL.md");
    const { ensureSkillsWatcher, closeSkillsWatchers } = await import("./refresh.js");
    const { getSkillsSnapshotVersion } = await import("./refresh-state.js");
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    const options = { config: {}, agentId: "main" };
    try {
      await fs.mkdir(skillDir, { recursive: true });
      if (lifecycle !== "initial") {
        ensureSkillsWatcher({ workspaceDir, ...options });
        if (lifecycle === "closed") {
          await closeSkillsWatchers();
        } else if (lifecycle === "disabled") {
          ensureSkillsWatcher({
            workspaceDir,
            ...options,
            config: { skills: { load: { watch: false } } },
          });
        } else {
          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60_000);
          try {
            ensureSkillsWatcher({ workspaceDir: path.join(root, "other"), ...options });
          } finally {
            clock.mockRestore();
          }
        }
      }
      // Cache the invalid file after teardown, so teardown invalidation cannot
      // accidentally prove freshness on reacquisition.
      nativeFs.writeFileSync(skillFile, "not valid skill frontmatter\n");
      const readSkill = () =>
        loadWorkspaceSkills(workspaceDir, options).find(
          (entry) => entry.skill.name === "acquire-proof",
        );
      expect(readSkill()).toBeUndefined();
      nativeFs.writeFileSync(
        skillFile,
        "---\nname: acquire-proof\ndescription: Repaired before acquisition\n---\n",
      );
      expect(readSkill()).toBeUndefined();
      // No await: the first synchronous consumer must not need a ready/change event.
      ensureSkillsWatcher({ workspaceDir, ...options });
      expect(readSkill()?.skill.description).toBe("Repaired before acquisition");
      const version = getSkillsSnapshotVersion(workspaceDir);
      ensureSkillsWatcher({ workspaceDir, ...options });
      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
    } finally {
      await closeSkillsWatchers();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["create", "edit"] as const)(
  "refreshes cached skills after %s during initial watcher registration",
  async (operation) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-scan-proof-")));
    const workspaceDir = path.join(root, "workspace");
    const skillDir = path.join(workspaceDir, "skills", "scan-proof");
    const skillFile = path.join(skillDir, "SKILL.md");
    const contents = (description: string) =>
      `---\nname: scan-proof\ndescription: ${description}\n---\n`;
    const { ensureSkillsWatcher, closeSkillsWatchers } = await import("./refresh.js");
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    const options = { config: {}, agentId: "main" };
    try {
      await fs.mkdir(path.dirname(skillDir), { recursive: true });
      if (operation === "edit") {
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(skillFile, contents("Before registration"));
      }
      ensureSkillsWatcher({ workspaceDir, ...options });
      const cached = loadWorkspaceSkills(workspaceDir, options);
      expect(cached.find((entry) => entry.skill.name === "scan-proof")?.skill.description).toBe(
        operation === "edit" ? "Before registration" : undefined,
      );
      // Keep the write in this turn, before native watcher registration, so
      // refresh cannot depend on receiving a subsequent file-change event.
      nativeFs.mkdirSync(skillDir, { recursive: true });
      nativeFs.writeFileSync(skillFile, contents("After registration"));
      await expect
        .poll(
          () =>
            loadWorkspaceSkills(workspaceDir, options).find(
              (entry) => entry.skill.name === "scan-proof",
            )?.skill.description,
          { timeout: 3_000 },
        )
        .toBe("After registration");
    } finally {
      await closeSkillsWatchers();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it("refreshes skills created beneath an initially missing project skills root", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-root-proof-")));
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceDir, "skills", "existing"), { recursive: true });
  const registeredPaths = new Set<string>();
  const turnContext = new AsyncLocalStorage<string>();
  const pendingInputContext = new AsyncLocalStorage<string>();
  const inheritedContexts: Array<{ turn?: string; pendingInput?: string }> = [];
  const originalWatch = nativeFs.watch;
  const watchObserver = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
    inheritedContexts.push({
      turn: turnContext.getStore(),
      pendingInput: pendingInputContext.getStore(),
    });
    const watcher = originalWatch(...args);
    registeredPaths.add(path.resolve(String(args[0])));
    return watcher;
  });
  syncBuiltinESMExports();
  const { ensureSkillsWatcher, closeSkillsWatchers, registerSkillsChangeListener } =
    await import("./refresh.js");
  const changes: string[] = [];
  let readyEvents = 0;
  const unregister = registerSkillsChangeListener((event) => {
    if (event.workspaceDir !== workspaceDir) {
      return;
    }
    if (event.reason === "watch") {
      if (event.changedPath) {
        changes.push(event.changedPath);
      } else {
        readyEvents += 1;
      }
    }
  });
  try {
    turnContext.run("active turn", () => {
      pendingInputContext.run("accepted input", () => {
        ensureSkillsWatcher({ workspaceDir });
        expect(turnContext.getStore()).toBe("active turn");
        expect(pendingInputContext.getStore()).toBe("accepted input");
      });
    });
    const existingSkill = path.join(workspaceDir, "skills", "existing", "SKILL.md");
    // This control covers writes after registration; the cases above cover
    // cached discovery while the initial scan is still pending. Wait for the
    // public ready invalidations because Bun cannot observe Chokidar's already-
    // bound node:fs export through the spy below.
    await vi.waitFor(() => {
      expect(readyEvents).toBe(1);
    });
    // Bun does not project spy replacements onto already-bound node:fs named exports.
    if (!process.versions.bun) {
      await vi.waitFor(() => {
        expect(registeredPaths.has(workspaceDir)).toBe(true);
        expect(registeredPaths.has(path.dirname(existingSkill))).toBe(true);
      });
    }
    await fs.writeFile(existingSkill, "existing skill");
    await vi.waitFor(() => expect(changes).toContain(existingSkill), { timeout: 3_000 });
    const newSkill = path.join(workspaceDir, ".agents", "skills", "new", "SKILL.md");
    await fs.mkdir(path.dirname(newSkill), { recursive: true });
    await fs.writeFile(newSkill, "new skill");
    await vi.waitFor(
      () => {
        expect(
          changes.some((changed) => changed.startsWith(path.join(workspaceDir, ".agents"))),
        ).toBe(true);
      },
      { timeout: 3_000 },
    );
    if (!process.versions.bun) {
      expect(inheritedContexts.length).toBeGreaterThan(0);
      for (const context of inheritedContexts) {
        expect(context).toEqual({ turn: undefined, pendingInput: undefined });
      }
    }
  } finally {
    unregister();
    await closeSkillsWatchers();
    watchObserver.mockRestore();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("shared missing skill ancestors", () => {
  // BEGIN TASK PATH DIAGNOSTIC
  type DiagnosticRawEvent = { event: string; path?: string; watchedPath?: string };
  type DiagnosticWatcherPath = {
    row: string;
    root: string;
    rawCount: number;
    firstRaw?: DiagnosticRawEvent;
    lastRaw?: DiagnosticRawEvent;
    readdirCalls: number;
    readdirAdmitted: number;
    readdirSuppressed: number;
    firstReaddir?: string;
    lastReaddir?: string;
  };
  const diagnosticWatcherPaths: Array<{
    watcher: ReturnType<typeof chokidar.watch>;
    record: DiagnosticWatcherPath;
  }> = [];
  let diagnosticWatcherOverflow = 0;
  // END TASK PATH DIAGNOSTIC
  // BEGIN TASK MINIMAL DIAGNOSTIC
  let diagnosticSnapshot: (() => void) | undefined;
  // END TASK MINIMAL DIAGNOSTIC
  const roots = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      // BEGIN TASK MINIMAL DIAGNOSTIC
      diagnosticSnapshot?.();
      // END TASK MINIMAL DIAGNOSTIC
      const { closeSkillsWatchers } = await import("./refresh.js");
      await closeSkillsWatchers(true);
      vi.restoreAllMocks();
      cleanup();
      // BEGIN TASK MINIMAL DIAGNOSTIC
      diagnosticSnapshot = undefined;
      // END TASK MINIMAL DIAGNOSTIC
    }),
  );

  it.each(["higher", "intermediate"] as const)(
    "preserves settled root discovery after moving its %s ancestor and retains sibling subscriptions",
    async (ancestor) => {
      // BEGIN TASK MINIMAL DIAGNOSTIC
      const diagnosticStart = performance.now();
      const diagnosticNow = () => Math.round(performance.now() - diagnosticStart);
      let diagnosticPhase = "fs:root-realpath";
      let diagnosticSerial = 0;
      type DiagnosticTimer = {
        id: number;
        delay: number | undefined;
        callback: string;
        createdAtMs: number;
      };
      const diagnosticTimers = new Map<Parameters<typeof clearTimeout>[0], DiagnosticTimer>();
      const diagnosticTimerState = (timer: Parameters<typeof clearTimeout>[0]) => {
        const ownValue = (key: string): unknown => {
          if (timer === null || typeof timer !== "object") return undefined;
          const descriptor = Object.getOwnPropertyDescriptor(timer, key);
          return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
        };
        const onTimeout = ownValue("_onTimeout");
        return {
          ...diagnosticTimers.get(timer),
          destroyed: ownValue("_destroyed"),
          idleTimeout: ownValue("_idleTimeout"),
          onTimeoutPresent: onTimeout !== undefined && onTimeout !== null,
        };
      };
      type DiagnosticDrain = {
        startedAtMs: number;
        timerCount: number;
        timers: ReturnType<typeof diagnosticTimerState>[];
        finishedAtMs?: number;
        pendingAfter?: number;
      };
      type DiagnosticSettle = {
        phase: string;
        startedAtMs: number;
        iterations: number;
        wait: string;
        firstDrain?: DiagnosticDrain;
        latestDrain?: DiagnosticDrain;
        finishedAtMs?: number;
        pendingAfter?: number;
      };
      const diagnosticSettles: DiagnosticSettle[] = [];
      let diagnosticPending = () => ({
        count: 0,
        timers: [] as ReturnType<typeof diagnosticTimerState>[],
      });
      diagnosticSnapshot = () => {
        process.stderr.write(
          `[skills-ancestor-minimal] ${JSON.stringify({
            row: ancestor,
            atMs: diagnosticNow(),
            phase: diagnosticPhase,
            settles: diagnosticSettles,
            // BEGIN TASK PATH DIAGNOSTIC
            watcherPaths: diagnosticWatcherPaths.map(({ watcher, record }) => ({
              ...record,
              closed: watcher.closed,
            })),
            watcherOverflow: diagnosticWatcherOverflow,
            // END TASK PATH DIAGNOSTIC
            pending: diagnosticPending(),
          })}\n`,
        );
      };
      // END TASK MINIMAL DIAGNOSTIC
      const root = await fs.realpath(roots.make("skills-shared-ancestor-"));
      const source = (name: string) => {
        const sourceRoot = path.join(root, name, "nested", "skills");
        return {
          workspaceDir: path.join(root, `workspace-${name}`),
          sourceRoot,
          config: { skills: { load: { extraDirs: [sourceRoot] } } },
        };
      };
      const first = source("left");
      const second = source("right");
      for (const current of [first, second]) {
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = `fs:workspace-mkdir:${current === first ? "first" : "second"}`;
        // END TASK MINIMAL DIAGNOSTIC
        await fs.mkdir(path.join(current.workspaceDir, "skills"), { recursive: true });
      }
      // BEGIN TASK MINIMAL DIAGNOSTIC
      diagnosticPhase = "imports";
      // END TASK MINIMAL DIAGNOSTIC
      const { ensureSkillsWatcher, registerSkillsChangeListener } = await import("./refresh.js");
      const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
      const originalWatch = chokidar.watch;
      const observed: Array<{ watcher: ReturnType<typeof chokidar.watch>; ready: boolean }> = [];
      const watcherErrors: unknown[] = [];
      const watch = vi.spyOn(chokidar, "watch").mockImplementation((...args) => {
        const watcher = originalWatch(...args);
        // BEGIN TASK PATH DIAGNOSTIC
        if (diagnosticWatcherPaths.length < 64) {
          const record: DiagnosticWatcherPath = {
            row: ancestor,
            root: String(args[0]),
            rawCount: 0,
            readdirCalls: 0,
            readdirAdmitted: 0,
            readdirSuppressed: 0,
          };
          diagnosticWatcherPaths.push({ watcher, record });
          watcher.on("raw", (event, rawPath, details) => {
            const sample: DiagnosticRawEvent = record.lastRaw ?? { event };
            sample.event = event;
            sample.path = typeof rawPath === "string" ? rawPath : undefined;
            sample.watchedPath =
              details && typeof details === "object" && typeof details.watchedPath === "string"
                ? details.watchedPath
                : undefined;
            record.rawCount += 1;
            record.firstRaw ??= { ...sample };
            record.lastRaw = sample;
          });
          const originalThrottle = watcher._throttle;
          watcher._throttle = function (action, throttlePath, timeout) {
            const throttle = originalThrottle.call(this, action, throttlePath, timeout);
            if (action === "readdir") {
              record.readdirCalls += 1;
              record.firstReaddir ??= throttlePath;
              record.lastReaddir = throttlePath;
              if (throttle) {
                record.readdirAdmitted += 1;
              } else {
                record.readdirSuppressed += 1;
              }
            }
            return throttle;
          };
        } else {
          diagnosticWatcherOverflow += 1;
        }
        // END TASK PATH DIAGNOSTIC
        const observation = { watcher, ready: false };
        observed.push(observation);
        // Attach before returning: promotion can create more watchers during ready.
        watcher.once("ready", () => {
          observation.ready = true;
        });
        watcher.on("error", (error) => watcherErrors.push(error));
        return watcher;
      });
      const originalSetTimeout = globalThis.setTimeout;
      const originalClearTimeout = globalThis.clearTimeout;
      const pendingTimers = new Map<
        Parameters<typeof clearTimeout>[0],
        { settled: Promise<void>; finish: () => void }
      >();
      // BEGIN TASK MINIMAL DIAGNOSTIC
      diagnosticPending = () => ({
        count: pendingTimers.size,
        timers: Array.from(pendingTimers.keys()).slice(0, 32).map(diagnosticTimerState),
      });
      // END TASK MINIMAL DIAGNOSTIC
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
        const { promise: settled, resolve: finish } = createDeferredCore();
        const timer = originalSetTimeout(() => {
          // BEGIN TASK MINIMAL DIAGNOSTIC
          diagnosticTimers.delete(timer);
          // END TASK MINIMAL DIAGNOSTIC
          pendingTimers.delete(timer);
          try {
            callback.apply(timer, args);
          } finally {
            finish();
          }
        }, delay);
        pendingTimers.set(timer, { settled, finish });
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticTimers.set(timer, {
          id: ++diagnosticSerial,
          delay,
          callback: callback.name || "anonymous",
          createdAtMs: diagnosticNow(),
        });
        // END TASK MINIMAL DIAGNOSTIC
        return timer;
      });
      vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
        originalClearTimeout(timer);
        pendingTimers.get(timer)?.finish();
        pendingTimers.delete(timer);
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticTimers.delete(timer);
        // END TASK MINIMAL DIAGNOSTIC
      });
      const settleWatchers = async () => {
        // BEGIN TASK MINIMAL DIAGNOSTIC
        const diagnosticSettle: DiagnosticSettle = {
          phase: diagnosticPhase,
          startedAtMs: diagnosticNow(),
          iterations: 0,
          wait: "ready",
        };
        diagnosticSettles.push(diagnosticSettle);
        // END TASK MINIMAL DIAGNOSTIC
        for (;;) {
          // BEGIN TASK MINIMAL DIAGNOSTIC
          diagnosticSettle.iterations += 1;
          diagnosticSettle.wait = "ready";
          // END TASK MINIMAL DIAGNOSTIC
          await vi.waitFor(() => {
            expect(watcherErrors).toEqual([]);
            expect(observed.every(({ watcher, ready }) => ready || watcher.closed)).toBe(true);
          });
          const generationCount = observed.length;
          // Drain actual debounce/stability work, including timers chained by its
          // continuations. Keep native time and watchers; do not sleep past a guess.
          // BEGIN TASK MINIMAL DIAGNOSTIC
          diagnosticSettle.wait = "timers";
          const diagnosticDrain: DiagnosticDrain = {
            startedAtMs: diagnosticNow(),
            timerCount: pendingTimers.size,
            timers: Array.from(pendingTimers.keys()).slice(0, 32).map(diagnosticTimerState),
          };
          diagnosticSettle.firstDrain ??= diagnosticDrain;
          diagnosticSettle.latestDrain = diagnosticDrain;
          // END TASK MINIMAL DIAGNOSTIC
          await Promise.all(Array.from(pendingTimers.values(), ({ settled }) => settled));
          // BEGIN TASK MINIMAL DIAGNOSTIC
          diagnosticDrain.finishedAtMs = diagnosticNow();
          diagnosticDrain.pendingAfter = pendingTimers.size;
          diagnosticSettle.wait = "immediate";
          // END TASK MINIMAL DIAGNOSTIC
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(watcherErrors).toEqual([]);
          if (
            pendingTimers.size === 0 &&
            observed.length === generationCount &&
            observed.every(({ watcher, ready }) => ready || watcher.closed)
          ) {
            // BEGIN TASK MINIMAL DIAGNOSTIC
            diagnosticSettle.wait = "";
            diagnosticSettle.finishedAtMs = diagnosticNow();
            diagnosticSettle.pendingAfter = pendingTimers.size;
            // END TASK MINIMAL DIAGNOSTIC
            return;
          }
        }
      };
      for (const current of [first, second]) {
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = `ensure:${current === first ? "first" : "second"}`;
        // END TASK MINIMAL DIAGNOSTIC
        ensureSkillsWatcher(current);
      }
      // BEGIN TASK MINIMAL DIAGNOSTIC
      diagnosticPhase = "settle:initial";
      // END TASK MINIMAL DIAGNOSTIC
      await settleWatchers();
      expect(
        watch.mock.calls.filter(([watched]) => watched === root.replaceAll("\\", "/")),
      ).toHaveLength(1);
      const changes: string[] = [];
      const unregister = registerSkillsChangeListener((event) => {
        if (event.workspaceDir) {
          changes.push(event.workspaceDir);
        }
      });
      const read = (current: typeof first) =>
        loadWorkspaceSkills(current.workspaceDir, {
          config: current.config,
          bundledSkillsDir: "",
          managedSkillsDir: path.join(root, "unused"),
        }).map((entry) => entry.skill.name);
      const writeSkill = async (current: typeof first, name: string) => {
        const directory = path.join(current.sourceRoot, name);
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = `fs:skill-mkdir:${name}`;
        // END TASK MINIMAL DIAGNOSTIC
        await fs.mkdir(directory, { recursive: true });
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = `fs:skill-write:${name}`;
        // END TASK MINIMAL DIAGNOSTIC
        await fs.writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: Shared ancestor proof\n---\n`,
        );
      };
      try {
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "read:first-empty";
        // END TASK MINIMAL DIAGNOSTIC
        expect(read(first)).toEqual([]);
        expect(read(second)).toEqual([]);
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "fs:unrelated-write";
        // END TASK MINIMAL DIAGNOSTIC
        await fs.writeFile(path.join(root, "unrelated.sqlite-wal"), "unrelated");
        await writeSkill(first, "first-proof");
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "poll:first-proof";
        // END TASK MINIMAL DIAGNOSTIC
        await expect.poll(() => read(first), { timeout: 3_000 }).toContain("first-proof");
        expect(changes).not.toContain(second.workspaceDir);
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "poll:promoted-watch";
        // END TASK MINIMAL DIAGNOSTIC
        await vi.waitFor(() => {
          expect(
            watch.mock.calls.some(
              ([watched], index) =>
                watched === first.sourceRoot.replaceAll("\\", "/") &&
                observed[index]?.ready &&
                !observed[index]?.watcher.closed,
            ),
          ).toBe(true);
        });
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "settle:promoted";
        // END TASK MINIMAL DIAGNOSTIC
        await settleWatchers();
        // Prime after promoted root/companion scans and queued refreshes settle:
        // late initial reconciliation must not mask a missed ancestor move.
        expect(read(first)).toContain("first-proof");
        const movedAncestor =
          ancestor === "higher" ? path.join(root, "left") : path.join(root, "left", "nested");
        if (process.platform === "win32") {
          // Windows cannot rename an ancestor with live descendant directory watches.
          // BEGIN TASK MINIMAL DIAGNOSTIC
          diagnosticPhase = "fs:remove-ancestor";
          // END TASK MINIMAL DIAGNOSTIC
          await fs.rm(movedAncestor, { recursive: true });
        } else {
          // BEGIN TASK MINIMAL DIAGNOSTIC
          diagnosticPhase = "fs:rename-ancestor";
          // END TASK MINIMAL DIAGNOSTIC
          await fs.rename(movedAncestor, `${movedAncestor}-away`);
        }
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "poll:removed-first";
        // END TASK MINIMAL DIAGNOSTIC
        await expect.poll(() => read(first), { timeout: 3_000 }).toEqual([]);
        await writeSkill(first, "returned-proof");
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "poll:returned-first";
        // END TASK MINIMAL DIAGNOSTIC
        await expect.poll(() => read(first), { timeout: 3_000 }).toEqual(["returned-proof"]);
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "settle:returned";
        // END TASK MINIMAL DIAGNOSTIC
        await settleWatchers();
        expect(read(first)).toEqual(["returned-proof"]);
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "unsubscribe:first";
        // END TASK MINIMAL DIAGNOSTIC
        // Retiring one logical workspace must not retire the shared missing-root observer.
        ensureSkillsWatcher({
          workspaceDir: first.workspaceDir,
          config: { skills: { load: { watch: false } } },
        });
        await writeSkill(second, "remaining-proof");
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "poll:remaining-right";
        // END TASK MINIMAL DIAGNOSTIC
        await expect.poll(() => read(second), { timeout: 3_000 }).toContain("remaining-proof");
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "remaining:rename-setup";
        // END TASK MINIMAL DIAGNOSTIC
        const skillFile = path.join(second.sourceRoot, "remaining-proof", "SKILL.md");
        const renamedSkillFile = path.join(second.sourceRoot, "remaining-proof", "SKILL.saved");
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "fs:rename-skill-away";
        // END TASK MINIMAL DIAGNOSTIC
        await fs.rename(skillFile, renamedSkillFile);
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "poll:skill-removed";
        // END TASK MINIMAL DIAGNOSTIC
        await expect.poll(() => read(second), { timeout: 3_000 }).toEqual([]);
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "fs:rename-skill-back";
        // END TASK MINIMAL DIAGNOSTIC
        await fs.rename(renamedSkillFile, skillFile);
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "poll:skill-restored";
        // END TASK MINIMAL DIAGNOSTIC
        await expect.poll(() => read(second), { timeout: 3_000 }).toContain("remaining-proof");
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "fs:remove-right";
        // END TASK MINIMAL DIAGNOSTIC
        await fs.rm(path.join(root, "right"), { recursive: true });
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "poll:removed-right";
        // END TASK MINIMAL DIAGNOSTIC
        await expect.poll(() => read(second), { timeout: 3_000 }).toEqual([]);
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "recreate:right";
        // END TASK MINIMAL DIAGNOSTIC
        await writeSkill(second, "recreated-proof");
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "poll:recreated-right";
        // END TASK MINIMAL DIAGNOSTIC
        await expect.poll(() => read(second), { timeout: 3_000 }).toContain("recreated-proof");
        // BEGIN TASK MINIMAL DIAGNOSTIC
        diagnosticPhase = "row:complete";
        // END TASK MINIMAL DIAGNOSTIC
      } finally {
        unregister();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not promote missing roots through newly created ancestor symlinks",
    async () => {
      const root = await fs.realpath(roots.make("skills-ancestor-symlink-"));
      const outside = await fs.realpath(roots.make("skills-ancestor-outside-"));
      const workspaceDir = path.join(root, "workspace");
      await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      const link = path.join(root, "missing");
      const sourceRoot = path.join(link, "nested", "skills");
      await fs.mkdir(path.join(outside, "nested", "skills", "outside-proof"), { recursive: true });
      const config = { skills: { load: { extraDirs: [sourceRoot] } } };
      const watch = vi.spyOn(chokidar, "watch");
      const { ensureSkillsWatcher } = await import("./refresh.js");
      const { getSkillsSourceVersion } = await import("./refresh-state.js");
      const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
      const read = () =>
        loadWorkspaceSkills(workspaceDir, {
          config,
          bundledSkillsDir: "",
          managedSkillsDir: path.join(root, "unused"),
        }).map((entry) => entry.skill.name);
      ensureSkillsWatcher({ workspaceDir, config });
      expect(read()).toEqual([]);
      await Promise.all(
        watch.mock.results.map((result) => {
          if (result.type !== "return") {
            throw new Error("Watcher acquisition failed");
          }
          return new Promise<void>((resolve, reject) => {
            result.value.once("ready", resolve);
            result.value.once("error", reject);
          });
        }),
      );
      // Ready handlers reconcile synchronously before these promises resolve.
      // Unchanged empty inventory suppresses public events, but discovery still invalidates.
      const sourceVersion = getSkillsSourceVersion(workspaceDir);
      await fs.symlink(outside, link, "dir");
      await expect
        .poll(() => getSkillsSourceVersion(workspaceDir), { timeout: 3_000 })
        .toBeGreaterThan(sourceVersion);
      expect(
        watch.mock.calls.some(
          ([watched]) =>
            typeof watched === "string" && (watched === link || watched.startsWith(`${link}/`)),
        ),
      ).toBe(false);
      await fs.unlink(link);
      const skillDir = path.join(sourceRoot, "ordinary-proof");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: ordinary-proof\ndescription: Ordinary replacement\n---\n",
      );
      await expect.poll(read, { timeout: 3_000 }).toContain("ordinary-proof");
    },
  );
});
