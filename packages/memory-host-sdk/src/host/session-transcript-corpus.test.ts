import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../../src/config/sessions/session-accessor.js";
import { registerOpenClawAgentDatabase } from "../../../../src/state/openclaw-agent-db-registry.js";
import { withOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { listSessionTranscriptCorpusEntriesForAgent } from "./session-files.js";
import { listSessionTranscriptCorpusEntriesForAgentSync } from "./session-transcript-corpus.js";

function pauseDirectoryDiscovery(sessionsDir: string) {
  const entered = createDeferred();
  const release = createDeferred();
  const realpath = fs.realpath.bind(fs);
  let paused = false;
  const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (file) => {
    if (!paused && file === sessionsDir) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return realpath(file);
  });
  return { entered, release, realpathSpy };
}

describe("listSessionTranscriptCorpusEntriesForAgent", () => {
  it.each([
    { includeContentRevision: true, archiveCount: 1, aliased: false },
    { includeContentRevision: false, archiveCount: 1, aliased: false },
    { includeContentRevision: false, archiveCount: 128, aliased: true },
    { includeContentRevision: false, archiveCount: 2048, aliased: true },
  ])(
    "preserves corpus paths and revisions for $archiveCount archives (aliased: $aliased, revisions: $includeContentRevision)",
    async ({ includeContentRevision, archiveCount, aliased }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const sessionsDir = state.sessionsDir();
        await fs.mkdir(sessionsDir, { recursive: true });
        let storePath = path.join(sessionsDir, "sessions.json");
        if (aliased) {
          const aliasRoot = state.statePath("aliases");
          await fs.symlink(state.statePath("agents"), aliasRoot, "junction");
          await state.writeConfig({
            session: { store: path.join(aliasRoot, "{agentId}", "sessions", "sessions.json") },
          });
          clearRuntimeConfigSnapshot();
          clearConfigCache();
          storePath = path.join(aliasRoot, "main", "sessions", "sessions.json");
        }
        const archiveIds = [
          "cron-thread",
          ...Array.from({ length: archiveCount - 1 }, (_, index) => `archive-${index}`),
        ];
        const archivePaths = archiveIds.map((sessionId) =>
          path.join(sessionsDir, `${sessionId}.jsonl.deleted.2026-02-16T22-27-33.000Z`),
        );
        const archivePath = path.join(
          sessionsDir,
          "cron-thread.jsonl.deleted.2026-02-16T22-27-33.000Z",
        );
        for (const filePath of archivePaths) {
          await fs.writeFile(filePath, "retained transcript");
        }
        await fs.writeFile(path.join(sessionsDir, "loose.jsonl"), "unowned live file");
        await upsertSessionEntryCore(
          {
            sessionKey: "agent:main:cron:job-1:run:run-1",
            storePath,
          },
          { sessionId: "cron-thread", updatedAt: 1 },
        );

        const options = { includeContentRevision, readOnly: aliased };
        const expected = listSessionTranscriptCorpusEntriesForAgentSync("main", options);
        const actual = await listSessionTranscriptCorpusEntriesForAgent("main", options);

        expect(actual).toEqual(expected);
        expect(actual).toHaveLength(archiveCount + 1);
        const archives = actual.filter((entry) => entry.artifactKind === "archive-artifact");
        expect(archives.map((entry) => entry.sessionFile).toSorted()).toEqual(
          archivePaths.toSorted(),
        );
        expect(archives.map((entry) => entry.sessionId).toSorted()).toEqual(archiveIds.toSorted());
        const archive = archives.find((entry) => entry.sessionFile === archivePath);
        expect(archive).toMatchObject({
          sessionFile: archivePath,
          sessionId: "cron-thread",
          generatedByCronRun: true,
          sessionKind: "cron",
        });
        expect(archive?.contentRevision !== undefined).toBe(includeContentRevision);
      });
    },
  );

  it.each([false, true])(
    "classifies prompt-rich entries without decoding saved prompts (readOnly: %s)",
    async (readOnly) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const sessionKey = "agent:main:corpus-metadata";
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const persisted = await upsertSessionEntryCore(
          { sessionKey, storePath },
          {
            sessionId: "corpus-metadata",
            updatedAt: 10,
            heartbeatIsolatedBaseSessionKey: "agent:main:main",
            skillsSnapshot: { prompt: "unused corpus prompt ".repeat(256), skills: [] },
            systemPromptReport: {
              source: "run",
              generatedAt: 1,
              systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
              injectedWorkspaceFiles: [],
              skills: { promptChars: 0, entries: [] },
              tools: { listChars: 0, schemaChars: 0, entries: [] },
            },
          },
        );

        const parse = vi.spyOn(JSON, "parse");
        try {
          const entries = await listSessionTranscriptCorpusEntriesForAgent("main", {
            includeContentRevision: false,
            includeRetainedSqlite: true,
            readOnly,
          });
          expect(entries).toEqual([
            {
              agentId: "main",
              artifactKind: "active-session",
              sessionFile: sessionKey,
              sessionId: "corpus-metadata",
              sessionKey,
              sessionKind: "heartbeat",
              storePath,
              transcriptSource: "sqlite",
              updatedAtMs: persisted?.updatedAt,
            },
          ]);
          const decodedEntries = parse.mock.calls.filter(([json]) =>
            json.includes('"sessionId":"corpus-metadata"'),
          );
          expect(
            decodedEntries.every(
              ([json]) =>
                !json.includes('"skillsSnapshot"') && !json.includes('"systemPromptReport"'),
            ),
          ).toBe(true);
        } finally {
          parse.mockRestore();
        }
      });
    },
  );

  it("yields during filesystem discovery while retaining its store and reading fresh entries", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionsDir = state.statePath("custom-sessions");
      const storePath = path.join(sessionsDir, "sessions.json");
      await fs.mkdir(sessionsDir, { recursive: true });
      await state.writeConfig({ session: { store: storePath } });
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      await upsertSessionEntryCore(
        { sessionKey: "agent:main:chat:original", storePath },
        { sessionId: "original", updatedAt: 1 },
      );
      const { entered, release, realpathSpy } = pauseDirectoryDiscovery(sessionsDir);
      const listing = listSessionTranscriptCorpusEntriesForAgent("main");
      try {
        await expect(
          Promise.race([entered.promise.then(() => "waiting"), listing.then(() => "completed")]),
        ).resolves.toBe("waiting");
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        await state.writeConfig({
          session: { store: state.statePath("replacement", "sessions.json") },
        });
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        await upsertSessionEntryCore(
          { sessionKey: "agent:main:chat:fresh", storePath },
          { sessionId: "fresh", updatedAt: 2 },
        );
        release.resolve();

        const entries = await listing;
        expect(entries.map((entry) => entry.sessionId).toSorted()).toEqual(["fresh", "original"]);
        expect(entries.every((entry) => entry.storePath === storePath)).toBe(true);
      } finally {
        release.resolve();
        try {
          await listing;
        } finally {
          realpathSpy.mockRestore();
        }
      }
    });
  });

  it("retains the custom store's registry environment while discovery is pending", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionsDir = state.statePath("custom-sessions");
      const storePath = path.join(sessionsDir, "sessions.json");
      const unsuffixedDatabase = path.join(sessionsDir, "openclaw-agent.sqlite");
      await fs.mkdir(sessionsDir, { recursive: true });
      await state.writeConfig({ session: { store: storePath } });
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      registerOpenClawAgentDatabase({ agentId: "ops", path: unsuffixedDatabase });
      const { entered, release, realpathSpy } = pauseDirectoryDiscovery(sessionsDir);
      const listing = listSessionTranscriptCorpusEntriesForAgent("main");
      try {
        await expect(
          Promise.race([entered.promise.then(() => "waiting"), listing.then(() => "completed")]),
        ).resolves.toBe("waiting");
        Reflect.set(process.env, "OPENCLAW_STATE_DIR", state.statePath("replacement-state"));
        release.resolve();

        await expect(listing).resolves.toEqual([]);
        expect(fsSync.existsSync(path.join(sessionsDir, "openclaw-agent.main.sqlite"))).toBe(true);
        expect(fsSync.existsSync(unsuffixedDatabase)).toBe(false);
      } finally {
        release.resolve();
        try {
          await listing;
        } finally {
          Reflect.set(process.env, "OPENCLAW_STATE_DIR", state.stateDir);
          realpathSpy.mockRestore();
        }
      }
    });
  });
});
