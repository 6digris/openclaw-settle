import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { privateFileStore } from "../infra/private-file-store.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { buildPolicyContextExcerpt } from "./embedded-agent-helpers/bootstrap.js";
import {
  sliceToolResultTextTailToBudget,
  sliceToolResultTextToBudget,
} from "./embedded-agent-runner/tool-result-text-budget.js";
import {
  readExtraSystemPromptContext,
  type ExtraSystemPromptContext,
} from "./extra-system-prompt-context.js";

// Match the ordinary bootstrap file allowance. A smaller model spends at most
// roughly a quarter of its context on supplemental text, using the shared
// CJK-aware token-pressure estimate rather than raw UTF-16 length.
const MAX_EXTRA_SYSTEM_PROMPT_CHARS = 20_000;
const log = createSubsystemLogger("agents/extra-context");

export type PreparedExtraSystemPrompt = {
  text: string | undefined;
  rawChars: number;
  injectedChars: number;
  truncated: boolean;
  sourceHash?: string;
  /** Reduction settings and the actual original reference, independent of caller text identity. */
  reductionHash?: string;
};

export type ExtraSystemPromptSource = {
  agentId: string;
  agentDir: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
};

/** Stable source identity includes its environment, while reader policy stays runtime-owned. */
export function resolveExtraSystemPromptSource(source: ExtraSystemPromptSource) {
  return {
    sourceScope: JSON.stringify([
      source.agentDir,
      source.storePath,
      source.agentId,
      source.sessionKey ?? source.sessionId,
    ]),
    incognito:
      isIncognitoSessionKey(source.sessionKey) ||
      Boolean(
        source.storePath &&
        isIncognitoOpenClawAgentSqlitePath(source.storePath, { agentId: source.agentId }),
      ),
  };
}

type OriginalArtifact = {
  filePath: Promise<string>;
  release: () => Promise<void>;
  users: number;
  closing?: Promise<void>;
};

type ExtraSystemPromptScope = {
  owner?: string;
  closed: boolean;
  prepared: Map<string, Map<string, Promise<PreparedExtraSystemPrompt>>>;
  originals: Set<OriginalArtifact>;
};

const scopes = new AsyncLocalStorage<ExtraSystemPromptScope>();
// Only active scopes hold originals. Concurrent users of the same source must
// not remove the file while another admitted run is still reading it.
const originals = new Map<string, OriginalArtifact>();

/** The logical run owns preparation and private originals through all retries. */
export async function withExtraSystemPromptScope<T>(
  run: () => Promise<T>,
  owner?: string,
): Promise<T> {
  const existing = scopes.getStore();
  if (existing && !existing.closed && existing.owner === owner) {
    return await run();
  }
  const scope: ExtraSystemPromptScope = {
    owner,
    closed: false,
    prepared: new Map(),
    originals: new Set(),
  };
  return await scopes.run(scope, async () => {
    try {
      return await run();
    } finally {
      scope.closed = true;
      scope.prepared.clear();
      try {
        const released = await Promise.allSettled(
          [...scope.originals].map((artifact) => artifact.release()),
        );
        const failed = released.filter((result) => result.status === "rejected").length;
        if (failed) {
          log.warn(
            `Private extra-context cleanup failed for ${failed} source(s); temporary originals may remain. The completed run result is preserved.`,
          );
        }
      } finally {
        scope.originals.clear();
      }
    }
  });
}

async function retainOriginal(
  scope: ExtraSystemPromptScope,
  text: string,
  sourceHash: string,
  sourceScope: string,
): Promise<string | undefined> {
  const store = privateFileStore(
    path.join(resolvePreferredOpenClawTmpDir(), "extra-system-prompts"),
  );
  // A later turn can recreate this same path after the prior scope closes.
  // Native instruction identity never depends on a random temporary filename.
  const fileName = `${sha256Hex(sourceScope)}-${sourceHash}.txt`;
  const key = store.path(fileName);
  let artifact = originals.get(key);
  while (artifact?.closing) {
    await artifact.closing;
    artifact = originals.get(key);
  }
  if (scope.closed) {
    return undefined;
  }
  if (!artifact) {
    const filePath = store.write(fileName, text, { durable: false });
    const created: OriginalArtifact = {
      filePath,
      users: 0,
      release: async () => {
        if (--created.users > 0) {
          return;
        }
        // A new scope waits for removal before recreating this deterministic
        // source. Deleting the entry first could remove the new owner's file.
        created.closing = (async () => {
          try {
            await created.filePath.catch(() => undefined);
            await store.remove(fileName);
          } finally {
            originals.delete(key);
          }
        })();
        await created.closing;
      },
    };
    artifact = created;
    originals.set(key, artifact);
  }
  if (!scope.originals.has(artifact)) {
    artifact.users++;
    scope.originals.add(artifact);
  }
  const filePath = await artifact.filePath;
  return scope.closed ? undefined : filePath;
}

function allocateExcerptBudgets(lengths: number[], available: number): number[] {
  const budgets = Array<number>(lengths.length).fill(0);
  let remaining = available;
  // Preserve short components whole, then share what remains across the large
  // ones so an early large source cannot erase every later source.
  const pending = lengths
    .map((length, index) => ({ length, index }))
    .toSorted((a, b) => a.length - b.length);
  for (const [i, { length, index }] of pending.entries()) {
    const budget = Math.min(length, Math.floor(remaining / (pending.length - i)));
    budgets[index] = budget;
    remaining -= budget;
  }
  return budgets;
}

function renderExcerpt(
  context: ExtraSystemPromptContext,
  maxChars: number,
  notice: string,
): string {
  const budgets = allocateExcerptBudgets(
    context.reducibleRanges.map((range) =>
      estimateStringChars(context.text.slice(range.start, range.end)),
    ),
    Math.max(0, maxChars - estimateStringChars(notice) - 2),
  );
  let cursor = 0;
  const parts: string[] = [];
  for (const [index, range] of context.reducibleRanges.entries()) {
    parts.push(context.text.slice(cursor, range.start));
    const original = context.text.slice(range.start, range.end);
    const budget = budgets[index] ?? 0;
    parts.push(
      estimateStringChars(original) <= budget
        ? original
        : budget > 0
          ? buildPolicyContextExcerpt(original, budget, {
              name: "supplemental context",
              omissionNotice: "[...content omitted...]",
              budget: {
                measure: estimateStringChars,
                head: sliceToolResultTextToBudget,
                tail: sliceToolResultTextTailToBudget,
              },
            }).content
          : "",
    );
    cursor = range.end;
  }
  parts.push(context.text.slice(cursor), "\n\n", notice);
  return parts.join("");
}

/** Projects only producer-designated bulky text; policy and trust frames stay whole. */
export async function prepareExtraSystemPrompt(
  owner: { extraSystemPrompt?: string },
  options: {
    contextTokenBudget?: number;
    sourceScope?: string;
    readAvailable?: boolean;
    incognito?: boolean;
  } = {},
): Promise<PreparedExtraSystemPrompt> {
  const context = readExtraSystemPromptContext(owner);
  const rawChars = owner.extraSystemPrompt?.length ?? 0;
  const unchanged = {
    text: owner.extraSystemPrompt,
    rawChars,
    injectedChars: rawChars,
    truncated: false,
  };
  if (!context) {
    return unchanged;
  }
  const maxChars = Math.min(
    MAX_EXTRA_SYSTEM_PROMPT_CHARS,
    typeof options.contextTokenBudget === "number" &&
      Number.isFinite(options.contextTokenBudget) &&
      options.contextTokenBudget > 0
      ? Math.max(1_024, Math.floor(options.contextTokenBudget))
      : MAX_EXTRA_SYSTEM_PROMPT_CHARS,
  );
  const scope = scopes.getStore();
  const readAvailable =
    options.readAvailable === true &&
    options.incognito !== true &&
    Boolean(options.sourceScope) &&
    scope !== undefined &&
    !scope.closed;
  const settings = JSON.stringify([
    maxChars,
    readAvailable,
    readAvailable ? options.sourceScope : undefined,
    context.reducibleRanges,
  ]);
  const cached = scope?.prepared.get(context.text)?.get(settings);
  if (cached) {
    return await cached;
  }
  const reducibleChars = context.reducibleRanges.reduce(
    (total, range) => total + estimateStringChars(context.text.slice(range.start, range.end)),
    0,
  );
  if (reducibleChars <= maxChars) {
    return unchanged;
  }
  const prepare = async (): Promise<PreparedExtraSystemPrompt> => {
    const sourceHash = sha256Hex(context.text);
    let sourcePath: string | undefined;
    if (readAvailable && scope && options.sourceScope) {
      // A failed scratch write must not turn oversized context into a new run
      // failure or advertise an original the selected tools cannot retrieve.
      sourcePath = await retainOriginal(scope, context.text, sourceHash, options.sourceScope).catch(
        () => undefined,
      );
    }
    const retrieval = sourcePath
      ? `The exact original is available only during this run and its retries at ${JSON.stringify(sourcePath)}. Use bounded portions with the permitted reader: offset/limit/cursor with read, or bounded shell reads. Existing instruction roles and untrusted-content boundaries still apply.`
      : "No retrievable original is available in this run. Answer from the visible context, or explain which missing detail you need; do not assume omitted instructions or enable unavailable tools.";
    const notice = `[Partial supplemental context: excerpts omit content and may omit qualifications; they are not a complete summary. Original ${rawChars} chars; source SHA-256 ${sourceHash}. ${retrieval}]`;
    const text = renderExcerpt(context, maxChars, notice);
    return {
      text,
      rawChars,
      injectedChars: text.length,
      truncated: true,
      sourceHash,
      // A permitted reader can still lose its original after a failed write.
      // Retained runtimes must refresh when the resulting reference changes.
      reductionHash: sha256Hex(JSON.stringify([maxChars, sourcePath ?? null])),
    };
  };
  const prepared = prepare();
  if (scope && !scope.closed) {
    let bySettings = scope.prepared.get(context.text);
    if (!bySettings) {
      bySettings = new Map();
      scope.prepared.set(context.text, bySettings);
    }
    bySettings.set(settings, prepared);
  }
  return await prepared;
}
