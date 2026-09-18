import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareJudgmentProviderReload } from "../../judgments/runtime.js";
import type {
  JudgmentBatch,
  JudgmentProviderV1,
  JudgmentBatchResult,
} from "../../judgments/types.js";
import { runPluginRegisterSyncInRegistry } from "../../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry, resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  buildWorkshopJudgmentEvidence,
  prepareWorkshopExperienceJudgment,
  prepareWorkshopCollectionJudgment,
} from "./judgment-guidance.js";
import { proposeCreateSkill } from "./service.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "judgment-guidance-" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
  await state.cleanup();
});
const config: OpenClawConfig = {
  judgments: { provider: "fixture" },
  skills: { workshop: { autonomous: { mode: "propose" } } },
};
function scope() {
  return { config, agentId: "main", signal: new AbortController().signal, assertCurrent() {} };
}
async function skill(name: string, text: string) {
  const file = path.join(resolveWorkshopSkillsDir(config, "main"), name, "SKILL.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `---\nname: ${name}\ndescription: Synthetic verification procedure.\n---\n${text}\n`,
  );
  return file;
}
async function provider(evaluate: JudgmentProviderV1["evaluate"], run: () => Promise<void>) {
  setRuntimeConfigSnapshot(config);
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "fixture",
    source: "/synthetic/index.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: { judgmentProviders: ["fixture"] },
  });
  const api = builder.createApi(record, { config });
  runPluginRegisterSyncInRegistry(
    (registration) =>
      registration.registerJudgmentProvider({ id: "fixture", contractVersion: 1, evaluate }),
    api,
    builder.registry,
    record.id,
  );
  builder.registry.plugins.push(record);
  setActivePluginRegistry(builder.registry);
  try {
    await run();
  } finally {
    prepareJudgmentProviderReload(builder.registry, new Set([record.id]));
    await getPluginInstance(record)?.dispose();
  }
}
function answers(batch: JudgmentBatch, pick: (id: string, labels: string[]) => string) {
  const result: Record<string, JudgmentBatchResult["answers"][string]> = {};
  for (const [id, q] of Object.entries(batch.questions)) {
    if (q.type !== "choice") {
      throw new Error("choice fixture");
    }
    const labels = Object.keys(q.criteria);
    const label = pick(id, labels);
    result[id] = {
      type: "choice",
      choice: label,
      probabilities: Object.fromEntries(labels.map((key) => [key, key === label ? 1 : 0])),
    };
  }
  return { status: "ok" as const, result: { model: "fixture-v1", answers: result } };
}
describe("revision-bound Workshop guidance", () => {
  it.each(["experience", "collection"])(
    "rejects cancellation during an empty %s catalog read",
    async (consumer) => {
      const controller = new AbortController();
      vi.spyOn(fs, "readdir").mockImplementationOnce(async () => {
        controller.abort(new Error("catalog authority closed"));
        throw Object.assign(new Error("missing fixture catalog"), { code: "ENOENT" });
      });
      await provider(
        async () => {
          throw new Error("must not dispatch after cancellation");
        },
        async () => {
          const current = { ...scope(), signal: controller.signal };
          await expect(
            consumer === "experience"
              ? prepareWorkshopExperienceJudgment({
                  ...current,
                  boundaries: 0,
                  messages: [{ role: "user", content: "One-time inspection." }],
                })
              : prepareWorkshopCollectionJudgment(current),
          ).rejects.toThrow("catalog authority closed");
        },
      );
    },
  );
  it("keeps legacy review without a selected provider even when one is registered", async () => {
    await provider(
      async () => {
        throw new Error("An unselected provider must not be called");
      },
      async () => {
        const unconfigured = { ...scope(), config: { ...config, judgments: undefined } };
        expect(
          await prepareWorkshopExperienceJudgment({
            ...unconfigured,
            boundaries: 0,
            messages: [{ role: "user", content: "Remember this verified procedure." }],
          }),
        ).toEqual({ route: "legacy", reason: "disabled" });
        expect(await prepareWorkshopCollectionJudgment(unconfigured)).toEqual({
          route: "legacy",
          reason: "disabled",
        });
      },
    );
  });
  it.each(["empty", "unmatched", "matched"])(
    "requires an identified existing target for a covered decision: %s",
    async (catalog) => {
      if (catalog !== "empty") {
        await skill("restart", "Validate the effective target before restart.");
      }
      const usedSkills = [{ name: "restart", source: "workspace", activation: "read" }] as const;
      await provider(
        async (batch) => {
          expect(batch.state).toMatchObject({ usedSkills });
          return answers(batch, () => (catalog === "matched" ? "covered:t0" : "unclear"));
        },
        async () => {
          const result = await prepareWorkshopExperienceJudgment({
            ...scope(),
            boundaries: 0,
            usedSkills,
            messages: [{ role: "user", content: "Remember this procedure in the skill." }],
          });
          expect(result).toEqual(
            catalog === "matched"
              ? { route: "no-change" }
              : { route: "legacy", reason: "ambiguous-or-inconsistent-decision" },
          );
        },
      );
    },
  );
  it("resolves a pending proposal to exact identity and carries retained early evidence", async () => {
    const draft = await proposeCreateSkill({
      config,
      agentId: "main",
      workspaceDir: resolveWorkshopSkillsDir(config, "main"),
      name: "preflight",
      description: "A synthetic preflight procedure.",
      content: "# Preflight\nValidate effective configuration before restart.\n",
      createdBy: "skill-workshop",
    });
    await provider(
      async (batch) => {
        return answers(batch, (id) => (id === "decision" ? "revise:t0" : "include"));
      },
      async () => {
        const result = await prepareWorkshopExperienceJudgment({
          ...scope(),
          boundaries: 0,
          messages: [
            {
              role: "user",
              content: "Early correction: validate effective config, not its template.",
            },
            { role: "assistant", content: "Done." },
          ],
        });
        expect(result.route).toBe("author");
        if (result.route !== "author") {
          throw new Error("expected author");
        }
        expect(result.prompt).toContain(draft.record.id);
        expect(result.prompt).toContain('"action":"revise"');
        expect(result.prompt).toContain("Early correction");
        expect(result.prompt).not.toContain("Skill review. Distill");
      },
    );
  });
  it("rejects a concurrently edited target instead of applying stale advice", async () => {
    const file = await skill("restart", "Validate before restart.");
    await provider(
      async (batch) => {
        await fs.appendFile(file, "Preserve the current file.\n");
        return answers(batch, (id) => (id === "decision" ? "update:t0" : "include"));
      },
      async () => {
        const result = await prepareWorkshopExperienceJudgment({
          ...scope(),
          boundaries: 0,
          messages: [{ role: "user", content: "Remember this procedure in the skill." }],
        });
        expect(result).toEqual({ route: "legacy", reason: "targets-changed" });
        expect(await fs.readFile(file, "utf8")).toContain("Preserve the current file");
      },
    );
  });
  it("accepts distinct responsibilities without invoking an LLM reviewer", async () => {
    const left = await skill(
      "certificate",
      "Rotate the web certificate; preserve certificate rollback instructions and see assets/cert.md.",
    );
    const right = await skill(
      "database",
      "Rotate the database encryption key; preserve the distinct database rollback trigger and assets/db.md.",
    );
    const before = await Promise.all([left, right].map((file) => fs.readFile(file, "utf8")));
    await provider(
      async (batch) => answers(batch, (id) => (id.includes(":") ? "distinct" : "keep")),
      async () => {
        const brief = await prepareWorkshopCollectionJudgment(scope());
        expect(brief).toEqual({ route: "no-change" });
        expect(await Promise.all([left, right].map((file) => fs.readFile(file, "utf8")))).toEqual(
          before,
        );
      },
    );
  });
  it("passes complete supporting authority and a fixed correction to the author", async () => {
    const left = await skill("old", "Restart acknowledgement allows cleanup; see policy.md.");
    await fs.writeFile(
      path.join(path.dirname(left), "policy.md"),
      "Operator correction: cleanup requires health PASS, not restart acknowledgement.",
    );
    await skill("current", "Require health PASS before cleanup.");
    await provider(
      async (batch) => {
        expect(JSON.stringify(batch.state)).toContain("Operator correction");
        return answers(batch, (id) => (id.includes(":") ? "correct_right" : "keep"));
      },
      async () => {
        const result = await prepareWorkshopCollectionJudgment(scope());
        expect(result.route).toBe("author");
        if (result.route !== "author") {
          throw new Error("expected author");
        }
        expect(result.prompt).toContain("correct_right");
        expect(result.prompt).not.toContain("Decide what to keep");
        expect(result.prompt).toContain("Operator correction");
      },
    );
  });
  it("falls back on incomplete catalogs without calling the provider", async () => {
    for (let i = 0; i < 33; i++) {
      await skill(`skill-${i}`, "Valid distinct procedure.");
    }
    await provider(
      async () => {
        throw new Error("must not evaluate a partial catalog");
      },
      async () => {
        expect(await prepareWorkshopCollectionJudgment(scope())).toEqual({
          route: "legacy",
          reason: "incomplete-catalog",
        });
      },
    );
  });
  it("rejects a create decision without included grounding", async () => {
    await provider(
      async (batch) => answers(batch, (id) => (id === "decision" ? "create" : "exclude")),
      async () => {
        expect(
          await prepareWorkshopExperienceJudgment({
            ...scope(),
            boundaries: 0,
            messages: [{ role: "user", content: "Do a thing" }],
          }),
        ).toEqual({ route: "legacy", reason: "ambiguous-or-inconsistent-decision" });
      },
    );
  });
  it("decides routine no-change with one question and no grounding dispatch", async () => {
    const batches: JudgmentBatch[] = [];
    await provider(
      async (batch) => {
        batches.push(batch);
        expect(Object.keys(batch.questions)).toEqual(["decision"]);
        expect(batch.questions.decision).toMatchObject({
          criteria: {
            none: expect.any(String),
            create: expect.any(String),
            unclear: expect.any(String),
          },
        });
        return answers(batch, () => "none");
      },
      async () => {
        expect(
          await prepareWorkshopExperienceJudgment({
            ...scope(),
            boundaries: 0,
            messages: [{ role: "user", content: "Report the receipt sum once." }],
          }),
        ).toEqual({ route: "no-change" });
        expect(batches).toHaveLength(1);
      },
    );
  });
  it("does not dismiss an explicit request as none", async () => {
    await provider(
      async (batch) => answers(batch, () => "none"),
      async () => {
        expect(
          await prepareWorkshopExperienceJudgment({
            ...scope(),
            boundaries: 0,
            messages: [{ role: "user", content: "Remember this workflow for future tasks." }],
          }),
        ).toEqual({ route: "legacy", reason: "ambiguous-or-inconsistent-decision" });
      },
    );
  });
  it("offers only concrete mode-appropriate plans at full catalog capacity", async () => {
    for (let i = 0; i < 32; i++) await skill(`skill-${i}`, `Procedure ${i}.`);
    await provider(
      async (batch) => {
        const question = batch.questions.decision;
        if (question?.type !== "choice") throw new Error("expected decision");
        const labels = Object.keys(question.criteria);
        expect(labels).toHaveLength(67);
        expect(labels.filter((label) => label.startsWith("update:"))).toHaveLength(32);
        expect(labels.filter((label) => label.startsWith("covered:"))).toHaveLength(32);
        expect(labels.some((label) => label.startsWith("revise:"))).toBe(false);
        return answers(batch, () => "none");
      },
      async () => {
        expect(
          await prepareWorkshopExperienceJudgment({
            ...scope(),
            mode: "auto",
            boundaries: 0,
            messages: [{ role: "user", content: "One-time inspection." }],
          }),
        ).toEqual({ route: "no-change" });
      },
    );
  });
  it("projects only bookkeeping while retaining authority, phase, errors and tool payloads", () => {
    const messages = [
      {
        role: "user",
        content: "Early correction: never delete the source before health PASS.",
        __openclaw: { senderIsOwner: true, id: "transport-id", seq: 2 },
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Checking the actual target.",
            textSignature: JSON.stringify({ id: "opaque", phase: "commentary" }),
          },
          {
            type: "toolCall",
            id: "call-1",
            name: "inspect",
            arguments: { model: "KEEP", usage: "KEEP", diagnostics: "KEEP" },
          },
        ],
        stopReason: "toolUse",
        model: "transport-model",
        usage: { ignored: "x".repeat(60_000) },
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "inspect",
        isError: true,
        content: [{ type: "text", text: "health FAIL; do not delete" }],
        usage: "ROOT TOOL PAYLOAD",
        diagnostics: "retain tool failure details",
        details: { usage: "KEEP", provider: "KEEP" },
      },
    ];
    const before = JSON.stringify(messages);
    const projected = buildWorkshopJudgmentEvidence(messages, 0);
    expect(projected.complete).toBe(true);
    expect(projected.evidence[0]?.message).toEqual({
      role: "user",
      content: messages[0]!.content,
      __openclaw: { senderIsOwner: true },
    });
    expect(projected.evidence[1]?.message).toMatchObject({
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Checking the actual target.", phase: "commentary" },
        {
          type: "toolCall",
          id: "call-1",
          name: "inspect",
          arguments: { model: "KEEP", usage: "KEEP", diagnostics: "KEEP" },
        },
      ],
    });
    expect(projected.evidence[2]?.message).toEqual(messages[2]);
    expect(JSON.stringify(projected)).not.toContain("transport-model");
    expect(JSON.stringify(messages)).toBe(before);
    expect(
      buildWorkshopJudgmentEvidence([{ role: "user", content: "x".repeat(48_001) }], 0).complete,
    ).toBe(false);
    expect(
      buildWorkshopJudgmentEvidence(
        [{ role: "user", content: [{ type: "image", data: "unseen" }] }],
        0,
      ).complete,
    ).toBe(false);
    expect(buildWorkshopJudgmentEvidence(messages, 1).complete).toBe(false);
  });
  it("conditions evidence on the fixed plan and closes selected observations over exact calls", async () => {
    const seen: JudgmentBatch[] = [];
    await provider(
      async (batch) => {
        seen.push(batch);
        if (batch.questions.decision) return answers(batch, () => "create");
        expect(batch.state).toMatchObject({ selectedPlan: { action: "create", target: null } });
        expect(JSON.stringify(batch.state)).toContain("Early correction");
        return answers(batch, (id) =>
          id.startsWith("e0:") || id.startsWith("e2:") ? "include" : "exclude",
        );
      },
      async () => {
        const result = await prepareWorkshopExperienceJudgment({
          ...scope(),
          boundaries: 0,
          messages: [
            {
              role: "user",
              content: "Early correction: test the effective target, not the template.",
            },
            {
              role: "assistant",
              content: [
                { type: "toolCall", id: "probe", name: "read", arguments: { path: "effective" } },
              ],
            },
            { role: "toolResult", toolCallId: "probe", content: "effective target: health PASS" },
            { role: "assistant", content: "Routine completion." },
          ],
        });
        expect(result.route).toBe("author");
        if (result.route !== "author") throw new Error("expected author");
        expect(result.prompt).toContain('"id":"probe"');
        expect(result.prompt).toContain('"toolCallId":"probe"');
        expect(result.prompt).toContain("Early correction");
        expect(result.prompt).not.toContain("Routine completion");
        expect(seen).toHaveLength(2);
      },
    );
  });
  it.each(["missing-call", "missing-result", "duplicate-call", "result-before-call"])(
    "rejects selected ungrounded tool linkage: %s",
    async (failure) => {
      const call = {
        role: "assistant",
        content: [{ type: "toolCall", id: "a", name: "check", arguments: {} }],
      };
      const result = { role: "toolResult", toolCallId: "a", content: "PASS" };
      const messages =
        failure === "missing-call"
          ? [result]
          : failure === "missing-result"
            ? [call]
            : failure === "result-before-call"
              ? [result, call]
              : [call, call, result];
      await provider(
        async (batch) => answers(batch, (id) => (id === "decision" ? "create" : "include")),
        async () => {
          expect(
            await prepareWorkshopExperienceJudgment({ ...scope(), boundaries: 0, messages }),
          ).toEqual({
            route: "legacy",
            reason: "ambiguous-or-inconsistent-decision",
          });
        },
      );
    },
  );
  it("keeps strict whole-batch validation for malformed evidence after a valid plan", async () => {
    let calls = 0;
    await provider(
      async (batch) => {
        calls++;
        const outcome = answers(batch, (id) => (id === "decision" ? "create" : "include"));
        if (!batch.questions.decision) {
          const id = Object.keys(outcome.result.answers)[0]!;
          outcome.result.answers[id] = {
            type: "choice",
            choice: "include",
            probabilities: { include: 0.49, exclude: 0.5, unclear: 0.01 },
          };
        }
        return outcome;
      },
      async () => {
        expect(
          await prepareWorkshopExperienceJudgment({
            ...scope(),
            boundaries: 0,
            messages: [
              {
                role: "user",
                content: "Always verify the selected generation before publication.",
              },
            ],
          }),
        ).toEqual({ route: "legacy", reason: "invalid-response" });
        expect(calls).toBe(2);
      },
    );
  });
  it("revalidates the entire catalog after grounding, including additions", async () => {
    let calls = 0;
    await provider(
      async (batch) => {
        calls++;
        if (!batch.questions.decision)
          await skill("newly-created", "Already contains this procedure.");
        return answers(batch, (id) => (id === "decision" ? "create" : "include"));
      },
      async () => {
        expect(
          await prepareWorkshopExperienceJudgment({
            ...scope(),
            boundaries: 0,
            messages: [{ role: "user", content: "Always check health before cleanup." }],
          }),
        ).toEqual({ route: "legacy", reason: "targets-changed" });
        expect(calls).toBe(2);
      },
    );
  });
  it.each(["cancel", "stale"])("does not dispatch grounding after %s authority", async (cause) => {
    const controller = new AbortController();
    let calls = 0;
    let stale = false;
    await provider(
      async (batch) => {
        calls++;
        if (cause === "cancel") controller.abort(new Error("closed authority"));
        else stale = true;
        return answers(batch, () => "create");
      },
      async () => {
        await expect(
          prepareWorkshopExperienceJudgment({
            ...scope(),
            signal: controller.signal,
            assertCurrent() {
              if (stale) throw new Error("closed authority");
            },
            boundaries: 0,
            messages: [{ role: "user", content: "Always check health before cleanup." }],
          }),
        ).rejects.toThrow("closed authority");
        expect(calls).toBe(1);
      },
    );
  });
  it("does not start grounding if local revalidation consumed the remaining budget", async () => {
    let now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let decisionReturned = false;
    let calls = 0;
    await provider(
      async (batch) => {
        calls++;
        decisionReturned = true;
        return answers(batch, () => "create");
      },
      async () => {
        expect(
          await prepareWorkshopExperienceJudgment({
            ...scope(),
            boundaries: 0,
            assertCurrent() {
              if (decisionReturned) {
                now += 2_100;
                decisionReturned = false;
              }
            },
            messages: [{ role: "user", content: "Always verify the effective target." }],
          }),
        ).toEqual({ route: "legacy", reason: "deadline" });
        expect(calls).toBe(1);
      },
    );
  });
  it.each([1_250, 2_100])(
    "shares one two-second deadline after %dms decision work",
    async (elapsed) => {
      let now = 10_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const deadlines: number[] = [];
      let calls = 0;
      await provider(
        async (batch, context) => {
          calls++;
          deadlines.push(context.deadlineMonotonicMs);
          if (batch.questions.decision) now += elapsed;
          return answers(batch, (id) => (id === "decision" ? "create" : "include"));
        },
        async () => {
          const result = await prepareWorkshopExperienceJudgment({
            ...scope(),
            boundaries: 0,
            messages: [{ role: "user", content: "Always check health before cleanup." }],
          });
          if (elapsed < 2_000) {
            expect(result.route).toBe("author");
            expect(calls).toBe(2);
            expect(deadlines).toEqual([12_000, 12_000]);
          } else {
            expect(result).toEqual({ route: "legacy", reason: "deadline" });
            expect(calls).toBe(1);
          }
        },
      );
    },
  );
  it("covers every pair across bounded batches without repeating skill bodies per pair", async () => {
    for (let i = 0; i < 13; i++) {
      await skill(`skill-${i}`, `Unique procedure evidence ${i}.`);
    }
    const seen = new Set<string>();
    await provider(
      async (batch) => {
        for (const id of Object.keys(batch.questions)) {
          expect(seen.has(id)).toBe(false);
          seen.add(id);
        }
        const payload = JSON.stringify(batch.state);
        expect(payload.split("Unique procedure evidence 0.")).toHaveLength(2);
        return answers(batch, (id) => (id.includes(":") ? "distinct" : "keep"));
      },
      async () => {
        expect(await prepareWorkshopCollectionJudgment(scope())).toEqual({ route: "no-change" });
        expect(seen.size).toBe(13 + (13 * 12) / 2);
      },
    );
  });
});
