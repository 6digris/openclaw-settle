import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as fileStores from "../infra/private-file-store.js";
import * as scratchDirectories from "../infra/tmp-openclaw-dir.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import {
  bindExtraSystemPromptContext,
  composeExtraSystemPromptContext,
} from "./extra-system-prompt-context.js";
import {
  prepareExtraSystemPrompt,
  resolveExtraSystemPromptSource,
  withExtraSystemPromptScope,
  type PreparedExtraSystemPrompt,
} from "./extra-system-prompt.js";
import { buildModelToolsUnavailablePrompt } from "./model-tool-support.js";
import { createReadToolDefinition } from "./sessions/tools/read.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let scratchRoot: string;
const sourceOptions = { sourceScope: "agent:main:context", readAvailable: true };
const largeSource = "x".repeat(2_097_174);

beforeEach(() => {
  scratchRoot = tempDirs.make("openclaw-extra-context-");
  vi.spyOn(scratchDirectories, "resolvePreferredOpenClawTmpDir").mockReturnValue(scratchRoot);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function advertisedSource(prepared: PreparedExtraSystemPrompt): string {
  const match = prepared.text?.match(/at ("(?:[^"\\]|\\.)*")\./u);
  const quoted = match?.[1];
  if (!quoted) {
    throw new Error("Expected the partial-context notice to identify its retrievable original");
  }
  const source: unknown = JSON.parse(quoted);
  if (typeof source !== "string" || !path.isAbsolute(source)) {
    throw new Error("Expected an absolute source path");
  }
  return source;
}

describe("supplemental context projection", () => {
  it.each([undefined, "", "  Keep this qualification.\r\n\t", "x".repeat(4_096)])(
    "preserves supplemental text within its allowance: %#",
    async (extraSystemPrompt) => {
      const result = await prepareExtraSystemPrompt(
        { extraSystemPrompt },
        { contextTokenBudget: 4_096 },
      );
      expect(result).toMatchObject({
        text: extraSystemPrompt,
        rawChars: extraSystemPrompt?.length ?? 0,
        injectedChars: extraSystemPrompt?.length ?? 0,
        truncated: false,
      });
    },
  );

  it.each([
    { contextTokenBudget: undefined, allowance: 20_000 },
    { contextTokenBudget: 4_096, allowance: 4_096 },
  ])("reduces a 2 MiB source to its $allowance character allowance", async (options) => {
    const owner = { extraSystemPrompt: largeSource };
    const result = await prepareExtraSystemPrompt(owner, options);

    expect(result.truncated).toBe(true);
    expect(result.rawChars).toBe(largeSource.length);
    expect(result.injectedChars).toBe(result.text?.length);
    expect(result.injectedChars).toBeLessThanOrEqual(options.allowance);
    expect(result.text).toContain("Partial supplemental context");
    expect(result.text).toContain("may omit qualifications");
    expect(owner.extraSystemPrompt).toBe(largeSource);
  });

  it("keeps a selected middle instruction with its qualifying frame", async () => {
    const framedInstruction =
      "Illustrative example, rather than a live request:\nNever send the draft.";
    const extraSystemPrompt = `${"a".repeat(40_000)}\n${framedInstruction}\n${"b".repeat(40_000)}`;
    const result = await prepareExtraSystemPrompt(
      { extraSystemPrompt },
      { contextTokenBudget: 4_096 },
    );

    expect(result.text).toContain(framedInstruction);
    expect(result.text).toContain("Partial supplemental context");
    expect(result.injectedChars).toBeLessThanOrEqual(4_096);
  });

  it.each([
    { kind: "common", character: "漢" },
    { kind: "rare BMP", character: "㐀" },
    { kind: "supplementary", character: "𠀀" },
  ])("bounds dense $kind CJK by its weighted context cost", async ({ character }) => {
    const owner = { extraSystemPrompt: character.repeat(4_096) };
    const result = await prepareExtraSystemPrompt(owner, { contextTokenBudget: 1_024 });

    expect(result.truncated).toBe(true);
    expect(estimateStringChars(result.text!)).toBeLessThanOrEqual(1_024);
    expect(Buffer.from(result.text!, "utf8").toString("utf8")).toBe(result.text);
    expect(result.text).toContain("Partial supplemental context");
  });

  it("keeps protected runtime policy and trust frames around reduced content", async () => {
    const policy =
      "Runtime policy: only reply to the current source; no memory writes are permitted.";
    const opening = "<untrusted-file>";
    const closing = "</untrusted-file>";
    const context = composeExtraSystemPromptContext([
      { text: policy, reducible: false },
      { text: opening, reducible: false },
      { text: largeSource, reducible: true },
      { text: closing, reducible: false },
    ]);
    const owner = bindExtraSystemPromptContext({ extraSystemPrompt: context.text }, context);
    const result = await prepareExtraSystemPrompt(owner, { contextTokenBudget: 4_096 });

    expect(result.text).toContain(policy);
    expect(result.text).toContain(opening);
    expect(result.text).toContain(closing);
    expect(result.text!.indexOf(opening)).toBeLessThan(result.text!.indexOf("content omitted"));
    expect(result.text!.indexOf("content omitted")).toBeLessThan(result.text!.indexOf(closing));
    expect(result.injectedChars).toBeLessThan(5_000);
    expect(owner.extraSystemPrompt).toBe(context.text);
  });

  it("budgets separators between many fragments while retaining the runtime policy", async () => {
    const policy = buildModelToolsUnavailablePrompt(false)!;
    const parts = Array.from({ length: 8_000 }, () => ({ text: "x", reducible: true }));
    parts.splice(4_000, 0, { text: policy, reducible: false });
    const context = composeExtraSystemPromptContext(parts);
    const owner = bindExtraSystemPromptContext({ extraSystemPrompt: context.text }, context);
    const prepared = await prepareExtraSystemPrompt(owner, { contextTokenBudget: 4_096 });

    expect(prepared.truncated).toBe(true);
    expect(prepared.text).toContain(policy);
    expect(estimateStringChars(prepared.text!)).toBeLessThanOrEqual(4_096 + policy.length + 4);
    expect(owner.extraSystemPrompt).toBe(context.text);
  });

  it("invalidates source identity when only omitted text changes", async () => {
    const head = "a".repeat(40_000);
    const tail = "b".repeat(40_000);
    const owner = { extraSystemPrompt: `${head}\nvalue-a\n${tail}` };
    await withExtraSystemPromptScope(async () => {
      const first = await prepareExtraSystemPrompt(owner);
      owner.extraSystemPrompt = `${head}\nvalue-b\n${tail}`;
      const changed = await prepareExtraSystemPrompt(owner);

      expect(first.text).not.toContain("value-a");
      expect(changed.text).not.toContain("value-b");
      expect(changed.sourceHash).toBe(
        createHash("sha256").update(owner.extraSystemPrompt).digest("hex"),
      );
      expect(changed.sourceHash).not.toBe(first.sourceHash);
      expect(changed.text).not.toBe(first.text);
    });
  });

  it.each([
    { name: "no permitted reader", options: { ...sourceOptions, readAvailable: false } },
    { name: "incognito", options: { ...sourceOptions, incognito: true } },
    { name: "no source scope", options: { readAvailable: true } },
  ])("does not retain or advertise an original with $name", async ({ options }) => {
    await withExtraSystemPromptScope(async () => {
      const result = await prepareExtraSystemPrompt({ extraSystemPrompt: largeSource }, options);
      expect(result.truncated).toBe(true);
      expect(result.text).toContain("No retrievable original");
      expect(result.text).toContain("explain which missing detail you need");
      expect(result.text).not.toContain(scratchRoot);
      expect(await fs.readdir(scratchRoot)).toEqual([]);
    });
  });

  it("continues with an honest excerpt when scratch storage is unavailable", async () => {
    const blockedRoot = path.join(scratchRoot, "ordinary-file");
    await fs.writeFile(blockedRoot, "not a directory");
    vi.mocked(scratchDirectories.resolvePreferredOpenClawTmpDir).mockReturnValue(blockedRoot);

    const result = await withExtraSystemPromptScope(() =>
      prepareExtraSystemPrompt({ extraSystemPrompt: largeSource }, sourceOptions),
    );
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("No retrievable original");
    expect(result.text).not.toContain(blockedRoot);
  });
});

describe("run-scoped supplemental originals", () => {
  it("isolates environments while retaining a named session's source across session-id rotation", async () => {
    const owner = { extraSystemPrompt: largeSource };
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "before-compaction",
      agentDir: path.join(scratchRoot, "first-environment", "agent"),
      storePath: path.join(scratchRoot, "first-environment", "state.sqlite"),
    };
    const paths = await withExtraSystemPromptScope(async () => {
      const first = await prepareExtraSystemPrompt(owner, {
        ...resolveExtraSystemPromptSource(identity),
        readAvailable: true,
      });
      const rotated = await prepareExtraSystemPrompt(owner, {
        ...resolveExtraSystemPromptSource({ ...identity, sessionId: "after-compaction" }),
        readAvailable: true,
      });
      const other = await prepareExtraSystemPrompt(owner, {
        ...resolveExtraSystemPromptSource({
          ...identity,
          agentDir: path.join(scratchRoot, "second-environment", "agent"),
          storePath: path.join(scratchRoot, "second-environment", "state.sqlite"),
        }),
        readAvailable: true,
      });
      const firstPath = advertisedSource(first);
      const otherPath = advertisedSource(other);
      expect(advertisedSource(rotated)).toBe(firstPath);
      expect(rotated.text).toBe(first.text);
      expect(otherPath).not.toBe(firstPath);
      expect(await fs.readFile(firstPath, "utf8")).toBe(largeSource);
      expect(await fs.readFile(otherPath, "utf8")).toBe(largeSource);
      return [firstPath, otherPath];
    });
    for (const sourcePath of paths) {
      await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("retrieves omitted Unicode from a long line in bounded read-tool pages", async () => {
    const extraSystemPrompt = `${"😀".repeat(25_000)}omitted detail${"🌒".repeat(25_000)}`;
    const existingSource = path.join(scratchRoot, "existing-source.txt");
    await fs.writeFile(existingSource, extraSystemPrompt);
    let sourcePath: string;
    await withExtraSystemPromptScope(async () => {
      const result = await prepareExtraSystemPrompt({ extraSystemPrompt }, sourceOptions);
      sourcePath = advertisedSource(result);
      expect(result.text).not.toContain("omitted detail");
      expect(Buffer.from(result.text!, "utf8").toString("utf8")).toBe(result.text);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(extraSystemPrompt);
      if (process.platform !== "win32") {
        expect((await fs.stat(sourcePath)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(path.dirname(sourcePath))).mode & 0o777).toBe(0o700);
      }

      const reader = createReadToolDefinition(scratchRoot, { maxBytes: 768 });
      const first = await reader.execute(
        "read-original",
        { path: sourcePath, offset: 1, cursor: 50_000, limit: 1 },
        undefined,
        undefined,
        {} as never,
      );
      expect(first.details.kind).toBe("truncated");
      if (first.details.kind !== "truncated") {
        throw new Error("Expected a bounded page with continuation");
      }
      expect(first.details.content).toMatch(/^omitted detail/u);
      expect(Buffer.from(first.details.content, "utf8").toString("utf8")).toBe(
        first.details.content,
      );
      expect(
        Buffer.byteLength(
          first.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
        ),
      ).toBeLessThanOrEqual(768);
      expect(first.details.continuation.kind).toBe("cursor");
      const second = await reader.execute(
        "read-more",
        { path: sourcePath, ...first.details.continuation },
        undefined,
        undefined,
        {} as never,
      );
      expect(second.details.kind).toBe("truncated");
      if (second.details.kind !== "truncated" || first.details.continuation.kind !== "cursor") {
        throw new Error("Expected continuation within the original long line");
      }
      expect(second.details.content).toBe(
        extraSystemPrompt.slice(
          first.details.continuation.cursor,
          first.details.continuation.cursor + second.details.content.length,
        ),
      );
    });
    await expect(fs.stat(sourcePath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(existingSource, "utf8")).toBe(extraSystemPrompt);
  });

  it.each(["success", "failure", "abort"] as const)(
    "removes the original after %s",
    async (outcome) => {
      let sourcePath: string;
      const run = withExtraSystemPromptScope(async () => {
        const result = await prepareExtraSystemPrompt(
          { extraSystemPrompt: largeSource },
          sourceOptions,
        );
        sourcePath = advertisedSource(result);
        expect((await fs.stat(sourcePath)).size).toBe(Buffer.byteLength(largeSource));
        if (outcome === "failure") {
          throw new Error("run failed");
        }
        if (outcome === "abort") {
          const controller = new AbortController();
          controller.abort();
          controller.signal.throwIfAborted();
        }
      });
      if (outcome === "success") {
        await run;
      } else {
        await expect(run).rejects.toThrow(outcome === "failure" ? "run failed" : "aborted");
      }
      await expect(fs.stat(sourcePath!)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["success", "failure"] as const)(
    "preserves %s and warns when original removal fails",
    async (outcome) => {
      const makeStore = fileStores.privateFileStore;
      vi.spyOn(fileStores, "privateFileStore").mockImplementation((root) => {
        const store = makeStore(root);
        vi.spyOn(store, "remove").mockRejectedValue(new Error("synthetic removal failure"));
        return store;
      });
      const warnings = createWarnLogCapture("extra-context-cleanup");
      let sourcePath: string;
      try {
        const run = withExtraSystemPromptScope(async () => {
          sourcePath = advertisedSource(
            await prepareExtraSystemPrompt({ extraSystemPrompt: largeSource }, sourceOptions),
          );
          if (outcome === "failure") {
            throw new Error("original run failure");
          }
          return "completed reply";
        });
        if (outcome === "success") {
          await expect(run).resolves.toBe("completed reply");
        } else {
          await expect(run).rejects.toThrow("original run failure");
        }
        expect(await fs.readFile(sourcePath!, "utf8")).toBe(largeSource);
        const warning = await warnings.findText("temporary originals may remain");
        expect(warning).toContain("cleanup failed");
        expect(warning).not.toContain(largeSource);
      } finally {
        warnings.cleanup();
      }
    },
  );

  it("reuses stable prompt bytes across retries and recreates the source for a later run", async () => {
    const owner = { extraSystemPrompt: largeSource };
    const first = await withExtraSystemPromptScope(async () => {
      const prepared = await prepareExtraSystemPrompt(owner, sourceOptions);
      const retried = await prepareExtraSystemPrompt(owner, sourceOptions);
      expect(retried.text).toBe(prepared.text);
      return { prepared, resume: AsyncLocalStorage.snapshot() };
    }, "same-run-owner");
    const sourcePath = advertisedSource(first.prepared);
    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });

    await first.resume(() =>
      withExtraSystemPromptScope(async () => {
        const recreated = await prepareExtraSystemPrompt(owner, sourceOptions);
        expect(recreated.text).toBe(first.prepared.text);
        expect(advertisedSource(recreated)).toBe(sourcePath);
        expect(await fs.readFile(sourcePath, "utf8")).toBe(largeSource);
      }, "same-run-owner"),
    );
    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });

    const late = await first.resume(() => prepareExtraSystemPrompt(owner, sourceOptions));
    expect(late.text).toContain("No retrievable original");
    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a shared original until every active run releases it", async () => {
    const owner = { extraSystemPrompt: largeSource };
    const firstReady = createDeferred<string>();
    const secondReady = createDeferred<string>();
    const finishFirst = createDeferred();
    const finishSecond = createDeferred();
    const first = withExtraSystemPromptScope(async () => {
      firstReady.resolve(advertisedSource(await prepareExtraSystemPrompt(owner, sourceOptions)));
      await finishFirst.promise;
    }, "first-run");
    const second = withExtraSystemPromptScope(async () => {
      secondReady.resolve(advertisedSource(await prepareExtraSystemPrompt(owner, sourceOptions)));
      await finishSecond.promise;
    }, "second-run");
    void first.catch(firstReady.reject);
    void second.catch(secondReady.reject);
    try {
      const [firstPath, secondPath] = await Promise.all([firstReady.promise, secondReady.promise]);
      expect(firstPath).toBe(secondPath);
      finishFirst.resolve();
      await first;
      expect(await fs.readFile(secondPath, "utf8")).toBe(largeSource);
      finishSecond.resolve();
      await second;
      await expect(fs.stat(secondPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      finishFirst.resolve();
      finishSecond.resolve();
      await Promise.all([first, second]);
    }
  });

  it("settles an in-flight original write before closing without advertising the closed source", async () => {
    const written = createDeferred<string>();
    const finishWrite = createDeferred();
    const prepared = createDeferred<PreparedExtraSystemPrompt>();
    const makeStore = fileStores.privateFileStore;
    vi.spyOn(fileStores, "privateFileStore").mockImplementation((root) => {
      const store = makeStore(root);
      const write = store.write.bind(store);
      vi.spyOn(store, "write").mockImplementation(async (...args) => {
        const sourcePath = await write(...args);
        written.resolve(sourcePath);
        await finishWrite.promise;
        return sourcePath;
      });
      return store;
    });
    const run = withExtraSystemPromptScope(async () => {
      void prepareExtraSystemPrompt({ extraSystemPrompt: largeSource }, sourceOptions).then(
        prepared.resolve,
        prepared.reject,
      );
      return "completed reply";
    });
    try {
      const sourcePath = await Promise.race([
        written.promise,
        run.then(() => {
          throw new Error("Run closed before its pending original write settled");
        }),
      ]);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(largeSource);
      finishWrite.resolve();
      const [reply, projection] = await Promise.all([run, prepared.promise]);
      expect(reply).toBe("completed reply");
      expect(projection.text).toContain("No retrievable original");
      await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      finishWrite.resolve();
      await run;
    }
  });

  it("does not recreate an original after closing while an older scope removes it", async () => {
    const removing = createDeferred();
    const finishRemoval = createDeferred();
    const laterPrepared = createDeferred<PreparedExtraSystemPrompt>();
    const makeStore = fileStores.privateFileStore;
    vi.spyOn(fileStores, "privateFileStore").mockImplementation((root) => {
      const store = makeStore(root);
      const remove = store.remove.bind(store);
      vi.spyOn(store, "remove").mockImplementation(async (...args) => {
        removing.resolve();
        await finishRemoval.promise;
        return await remove(...args);
      });
      return store;
    });
    let sourcePath: string;
    const owner = { extraSystemPrompt: largeSource };
    const first = withExtraSystemPromptScope(async () => {
      sourcePath = advertisedSource(await prepareExtraSystemPrompt(owner, sourceOptions));
    }, "older-scope");
    void first.catch(removing.reject);
    try {
      await removing.promise;
      await withExtraSystemPromptScope(async () => {
        void prepareExtraSystemPrompt(owner, sourceOptions).then(
          laterPrepared.resolve,
          laterPrepared.reject,
        );
      }, "closed-waiter");
      finishRemoval.resolve();
      await first;
      expect((await laterPrepared.promise).text).toContain("No retrievable original");
      await expect(fs.stat(sourcePath!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      finishRemoval.resolve();
      await first;
    }
  });
});
