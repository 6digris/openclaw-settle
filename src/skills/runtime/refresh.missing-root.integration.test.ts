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
// BEGIN TASK DIAGNOSTIC OVERLAY
  let diagnosticSnapshot: (() => void) | undefined;
  let diagnosticPhaseMark: ((phase: string) => void) | undefined;
// END TASK DIAGNOSTIC OVERLAY
  const roots = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
// BEGIN TASK DIAGNOSTIC OVERLAY
      diagnosticSnapshot?.();
      diagnosticPhaseMark?.("afterEach:entry");
// END TASK DIAGNOSTIC OVERLAY
      const { closeSkillsWatchers } = await import("./refresh.js");
// BEGIN TASK DIAGNOSTIC OVERLAY
      diagnosticPhaseMark?.("afterEach:close-watchers:start");
// END TASK DIAGNOSTIC OVERLAY
      await closeSkillsWatchers(true);
// BEGIN TASK DIAGNOSTIC OVERLAY
      diagnosticPhaseMark?.("afterEach:close-watchers:end");
// END TASK DIAGNOSTIC OVERLAY
      vi.restoreAllMocks();
// BEGIN TASK DIAGNOSTIC OVERLAY
      diagnosticPhaseMark?.("afterEach:restore:end");
// END TASK DIAGNOSTIC OVERLAY
      cleanup();
// BEGIN TASK DIAGNOSTIC OVERLAY
      diagnosticPhaseMark?.("afterEach:cleanup:end");
      diagnosticSnapshot = undefined;
      diagnosticPhaseMark = undefined;
// END TASK DIAGNOSTIC OVERLAY
    }),
  );

  it.each(["higher", "intermediate"] as const)(
    "preserves settled root discovery after moving its %s ancestor and retains sibling subscriptions",
    async (ancestor) => {
// BEGIN TASK DIAGNOSTIC OVERLAY
      const diagnosticStartedAt = performance.now();
      let diagnosticPhase = "row:start";
      let diagnosticWait = "";
      let diagnosticIteration = 0;
      let diagnosticSerial = 0;
      let diagnosticEventCount = 0;
      let diagnosticAwaitedTimerCount = 0;
      let diagnosticAwaitedTimerIds: Array<number | undefined> = [];
      const diagnosticRecent: Array<Record<string, unknown>> = [];
      const diagnosticStacks = new Map<string, { id: number; stack: string }>();
      const diagnosticCancellationStacks: Array<{ id: number; stack: string }> = [];
      const diagnosticTimers = new Map<Parameters<typeof clearTimeout>[0], {
        id: number; delay: number | undefined; startedAt: number; callback: string; stackId?: number;
      }>();
      const diagnosticElapsed = () => Math.round(performance.now() - diagnosticStartedAt);
      const diagnosticEvent = (event: string, detail: Record<string, unknown> = {}) => {
        diagnosticEventCount += 1;
        diagnosticRecent.push({ atMs: diagnosticElapsed(), event, phase: diagnosticPhase, ...detail });
        if (diagnosticRecent.length > 128) diagnosticRecent.shift();
      };
      const diagnosticMark = (phase: string) => {
        diagnosticPhase = phase;
        diagnosticEvent("phase");
        process.stderr.write(`[skills-ancestor-diag] ${JSON.stringify({ row: ancestor, atMs: diagnosticElapsed(), phase })}\n`);
      };
      let diagnosticWatcherState = () => ({ total: 0, ready: 0, closed: 0, paths: [] as string[] });
      diagnosticPhaseMark = diagnosticMark;
      diagnosticSnapshot = () => {
        process.stderr.write(`[skills-ancestor-diag-final] ${JSON.stringify({
          row: ancestor,
          atMs: diagnosticElapsed(),
          phase: diagnosticPhase,
          wait: diagnosticWait,
          iterations: diagnosticIteration,
          awaitedTimerCount: diagnosticAwaitedTimerCount,
          awaitedTimerIds: diagnosticAwaitedTimerIds,
          watcherState: diagnosticWatcherState(),
          pendingTimerCount: diagnosticTimers.size,
          pendingTimers: Array.from(diagnosticTimers.values()).slice(0, 24).map((timer) => ({
            id: timer.id, delay: timer.delay, ageMs: diagnosticElapsed() - timer.startedAt,
            callback: timer.callback, stackId: timer.stackId,
          })),
          stacks: Array.from(diagnosticStacks.values()),
          cancellationStacks: diagnosticCancellationStacks,
          eventCount: diagnosticEventCount,
          recent: diagnosticRecent,
        })}\n`);
      };
      diagnosticMark("fs:root-realpath:start");
// END TASK DIAGNOSTIC OVERLAY
      const root = await fs.realpath(roots.make("skills-shared-ancestor-"));
// BEGIN TASK DIAGNOSTIC OVERLAY
      diagnosticMark("fs:root-realpath:end");
// END TASK DIAGNOSTIC OVERLAY
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
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark(`fs:workspace-mkdir:${current === first ? "first" : "second"}:start`);
// END TASK DIAGNOSTIC OVERLAY
        await fs.mkdir(path.join(current.workspaceDir, "skills"), { recursive: true });
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark(`fs:workspace-mkdir:${current === first ? "first" : "second"}:end`);
// END TASK DIAGNOSTIC OVERLAY
      }
      const { ensureSkillsWatcher, registerSkillsChangeListener } = await import("./refresh.js");
      const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
// BEGIN TASK DIAGNOSTIC OVERLAY
      diagnosticMark("imports:complete");
// END TASK DIAGNOSTIC OVERLAY
      const originalWatch = chokidar.watch;
      const observed: Array<{ watcher: ReturnType<typeof chokidar.watch>; ready: boolean }> = [];
      const watcherErrors: unknown[] = [];
// BEGIN TASK DIAGNOSTIC OVERLAY
      const diagnosticWatchPaths: string[] = [];
      diagnosticWatcherState = () => ({
        total: observed.length,
        ready: observed.filter(({ ready }) => ready).length,
        closed: observed.filter(({ watcher }) => watcher.closed).length,
        paths: diagnosticWatchPaths.slice(0, 32),
      });
// END TASK DIAGNOSTIC OVERLAY
      const watch = vi.spyOn(chokidar, "watch").mockImplementation((...args) => {
        const watcher = originalWatch(...args);
        const observation = { watcher, ready: false };
        observed.push(observation);
// BEGIN TASK DIAGNOSTIC OVERLAY
        const diagnosticWatcherId = observed.length;
        if (diagnosticWatchPaths.length < 32) diagnosticWatchPaths.push(String(args[0]));
        diagnosticEvent("watcher:create", { id: diagnosticWatcherId, path: String(args[0]) });
// END TASK DIAGNOSTIC OVERLAY
        // Attach before returning: promotion can create more watchers during ready.
        watcher.once("ready", () => {
          observation.ready = true;
// BEGIN TASK DIAGNOSTIC OVERLAY
          diagnosticEvent("watcher:ready", { id: diagnosticWatcherId });
// END TASK DIAGNOSTIC OVERLAY
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
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
        const { promise: settled, resolve: finish } = createDeferredCore();
        const timer = originalSetTimeout(() => {
// BEGIN TASK DIAGNOSTIC OVERLAY
          const diagnosticTimer = diagnosticTimers.get(timer);
          diagnosticEvent("timer:fire", { id: diagnosticTimer?.id, pending: diagnosticTimers.size });
          diagnosticTimers.delete(timer);
// END TASK DIAGNOSTIC OVERLAY
          pendingTimers.delete(timer);
          try {
            callback.apply(timer, args);
          } finally {
            finish();
          }
        }, delay);
        pendingTimers.set(timer, { settled, finish });
// BEGIN TASK DIAGNOSTIC OVERLAY
        const diagnosticCallback = callback.name || "anonymous";
        const diagnosticKey = `${diagnosticCallback}:${delay}:${Function.prototype.toString.call(callback).slice(0, 160)}`;
        let diagnosticStack = diagnosticStacks.get(diagnosticKey);
        if (!diagnosticStack && diagnosticStacks.size < 32) {
          diagnosticStack = {
            id: diagnosticStacks.size + 1,
            stack: (new Error().stack ?? "").split("\n").slice(2, 7).join("\n"),
          };
          diagnosticStacks.set(diagnosticKey, diagnosticStack);
        }
        diagnosticSerial += 1;
        diagnosticTimers.set(timer, {
          id: diagnosticSerial, delay, startedAt: diagnosticElapsed(),
          callback: diagnosticCallback, stackId: diagnosticStack?.id,
        });
        diagnosticEvent("timer:create", { id: diagnosticSerial, delay, stackId: diagnosticStack?.id });
// END TASK DIAGNOSTIC OVERLAY
        return timer;
      });
      vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
        originalClearTimeout(timer);
// BEGIN TASK DIAGNOSTIC OVERLAY
        const diagnosticTimer = diagnosticTimers.get(timer);
        if (diagnosticTimer) {
          let cancellationStackId: number | undefined;
          if (diagnosticCancellationStacks.length < 32) {
            cancellationStackId = diagnosticCancellationStacks.length + 1;
            diagnosticCancellationStacks.push({
              id: cancellationStackId,
              stack: (new Error().stack ?? "").split("\n").slice(2, 7).join("\n"),
            });
          }
          diagnosticEvent("timer:clear", { id: diagnosticTimer.id, cancellationStackId });
          diagnosticTimers.delete(timer);
        }
// END TASK DIAGNOSTIC OVERLAY
        pendingTimers.get(timer)?.finish();
        pendingTimers.delete(timer);
      });
      const settleWatchers = async () => {
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticEvent("settle:enter");
// END TASK DIAGNOSTIC OVERLAY
        for (;;) {
// BEGIN TASK DIAGNOSTIC OVERLAY
          diagnosticIteration += 1;
          diagnosticWait = "ready";
          diagnosticEvent("settle:ready", { iteration: diagnosticIteration });
// END TASK DIAGNOSTIC OVERLAY
          await vi.waitFor(() => {
            expect(watcherErrors).toEqual([]);
            expect(observed.every(({ watcher, ready }) => ready || watcher.closed)).toBe(true);
          });
          const generationCount = observed.length;
          // Drain actual debounce/stability work, including timers chained by its
          // continuations. Keep native time and watchers; do not sleep past a guess.
// BEGIN TASK DIAGNOSTIC OVERLAY
          diagnosticWait = "timers";
          diagnosticAwaitedTimerCount = pendingTimers.size;
          diagnosticAwaitedTimerIds = Array.from(pendingTimers.keys()).slice(0, 24).map((timer) => diagnosticTimers.get(timer)?.id);
          diagnosticEvent("settle:timer-drain", { pending: pendingTimers.size, ids: diagnosticAwaitedTimerIds });
// END TASK DIAGNOSTIC OVERLAY
          await Promise.all(Array.from(pendingTimers.values(), ({ settled }) => settled));
// BEGIN TASK DIAGNOSTIC OVERLAY
          diagnosticEvent("settle:timer-drain-complete");
          diagnosticAwaitedTimerCount = 0;
          diagnosticAwaitedTimerIds = [];
          diagnosticWait = "immediate";
          diagnosticEvent("settle:immediate");
// END TASK DIAGNOSTIC OVERLAY
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(watcherErrors).toEqual([]);
          if (
            pendingTimers.size === 0 &&
            observed.length === generationCount &&
            observed.every(({ watcher, ready }) => ready || watcher.closed)
          ) {
// BEGIN TASK DIAGNOSTIC OVERLAY
            diagnosticWait = "";
            diagnosticEvent("settle:exit");
// END TASK DIAGNOSTIC OVERLAY
            return;
          }
        }
      };
      for (const current of [first, second]) {
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark(`ensure:${current === first ? "first" : "second"}:start`);
// END TASK DIAGNOSTIC OVERLAY
        ensureSkillsWatcher(current);
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark(`ensure:${current === first ? "first" : "second"}:end`);
// END TASK DIAGNOSTIC OVERLAY
      }
// BEGIN TASK DIAGNOSTIC OVERLAY
      diagnosticMark("settle:initial");
// END TASK DIAGNOSTIC OVERLAY
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
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark(`fs:skill-mkdir:${name}:start`);
// END TASK DIAGNOSTIC OVERLAY
        await fs.mkdir(directory, { recursive: true });
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark(`fs:skill-write:${name}:start`);
// END TASK DIAGNOSTIC OVERLAY
        await fs.writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: Shared ancestor proof\n---\n`,
        );
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark(`fs:skill-write:${name}:end`);
// END TASK DIAGNOSTIC OVERLAY
      };
      try {
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("read:first-empty");
// END TASK DIAGNOSTIC OVERLAY
        expect(read(first)).toEqual([]);
        expect(read(second)).toEqual([]);
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("fs:unrelated-write:start");
// END TASK DIAGNOSTIC OVERLAY
        await fs.writeFile(path.join(root, "unrelated.sqlite-wal"), "unrelated");
        await writeSkill(first, "first-proof");
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("poll:first-proof");
// END TASK DIAGNOSTIC OVERLAY
        await expect.poll(() => read(first), { timeout: 3_000 }).toContain("first-proof");
        expect(changes).not.toContain(second.workspaceDir);
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("poll:promoted-watch");
// END TASK DIAGNOSTIC OVERLAY
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
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("settle:promoted");
// END TASK DIAGNOSTIC OVERLAY
        await settleWatchers();
        // Prime after promoted root/companion scans and queued refreshes settle:
        // late initial reconciliation must not mask a missed ancestor move.
        expect(read(first)).toContain("first-proof");
        const movedAncestor =
          ancestor === "higher" ? path.join(root, "left") : path.join(root, "left", "nested");
        if (process.platform === "win32") {
          // Windows cannot rename an ancestor with live descendant directory watches.
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("fs:remove-ancestor:start");
// END TASK DIAGNOSTIC OVERLAY
          await fs.rm(movedAncestor, { recursive: true });
        } else {
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("fs:rename-ancestor:start");
// END TASK DIAGNOSTIC OVERLAY
          await fs.rename(movedAncestor, `${movedAncestor}-away`);
        }
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("poll:removed-first");
// END TASK DIAGNOSTIC OVERLAY
        await expect.poll(() => read(first), { timeout: 3_000 }).toEqual([]);
        await writeSkill(first, "returned-proof");
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("poll:returned-first");
// END TASK DIAGNOSTIC OVERLAY
        await expect.poll(() => read(first), { timeout: 3_000 }).toEqual(["returned-proof"]);
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("settle:returned");
// END TASK DIAGNOSTIC OVERLAY
        await settleWatchers();
        expect(read(first)).toEqual(["returned-proof"]);
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("unsubscribe:first");
// END TASK DIAGNOSTIC OVERLAY
        // Retiring one logical workspace must not retire the shared missing-root observer.
        ensureSkillsWatcher({
          workspaceDir: first.workspaceDir,
          config: { skills: { load: { watch: false } } },
        });
        await writeSkill(second, "remaining-proof");
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("poll:remaining-right");
// END TASK DIAGNOSTIC OVERLAY
        await expect.poll(() => read(second), { timeout: 3_000 }).toContain("remaining-proof");
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("remaining:rename-setup");
// END TASK DIAGNOSTIC OVERLAY
        const skillFile = path.join(second.sourceRoot, "remaining-proof", "SKILL.md");
        const renamedSkillFile = path.join(second.sourceRoot, "remaining-proof", "SKILL.saved");
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("fs:rename-skill-away:start");
// END TASK DIAGNOSTIC OVERLAY
        await fs.rename(skillFile, renamedSkillFile);
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("poll:skill-removed");
// END TASK DIAGNOSTIC OVERLAY
        await expect.poll(() => read(second), { timeout: 3_000 }).toEqual([]);
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("fs:rename-skill-back:start");
// END TASK DIAGNOSTIC OVERLAY
        await fs.rename(renamedSkillFile, skillFile);
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("poll:skill-restored");
// END TASK DIAGNOSTIC OVERLAY
        await expect.poll(() => read(second), { timeout: 3_000 }).toContain("remaining-proof");
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("fs:remove-right:start");
// END TASK DIAGNOSTIC OVERLAY
        await fs.rm(path.join(root, "right"), { recursive: true });
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("poll:removed-right");
// END TASK DIAGNOSTIC OVERLAY
        await expect.poll(() => read(second), { timeout: 3_000 }).toEqual([]);
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("recreate:right");
// END TASK DIAGNOSTIC OVERLAY
        await writeSkill(second, "recreated-proof");
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("poll:recreated-right");
// END TASK DIAGNOSTIC OVERLAY
        await expect.poll(() => read(second), { timeout: 3_000 }).toContain("recreated-proof");
      } finally {
// BEGIN TASK DIAGNOSTIC OVERLAY
        diagnosticMark("row:finally");
// END TASK DIAGNOSTIC OVERLAY
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
