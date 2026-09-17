---
summary: "The exclusive context-engine and memory-capability slots and their embedding adapters"
title: "Plugin SDK memory and context slots"
sidebarTitle: "Memory and context slots"
read_when:
  - You are registering a context engine or a memory capability
  - You need the durable admitted-turn contract for context engines
  - You are exposing memory embedding or public-artifact adapters
---

The registrars that allow only one active implementation at a time, and the
memory adapter contracts that sit on top of them. Part of the
[Plugin SDK overview](/plugins/sdk-overview).

## Exclusive slots

| Method                                     | What it registers                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api.registerContextEngine(id, factory)`   | Context engine (one active at a time). Use `info.acceptedHostParams` to restrict accepted host-added lifecycle fields, including optional `maintain()` cancellation; undeclared engines receive all current host fields. |
| `api.registerMemoryCapability(capability)` | Unified memory capability                                                                                                                                                                                                |

To participate in durable admitted turns, context engines must declare
`currentTurnFence: "before-current-turn-entry-v1"` and
`turnAdvancementIdempotency: "atomic-idempotent-v1"` under
`info.transcriptSemantics`, then implement `commitTurn(...)` as an atomic,
idempotent write keyed by `advancementKey`. OpenClaw supplies only the inclusive
accepted turn, from its admitted user entry through its terminal entry; use the
`readSessionTranscriptVisibleMessageDelta(...)` cursor API to bootstrap or
rebuild earlier history. Without the full contract, OpenClaw uses the legacy
context path for the whole logical turn and its retries, leaves the configured
engine unchanged, and tries that engine again on the next logical turn.

## Memory embedding adapters

- `registerMemoryCapability` is the exclusive memory-plugin API.
- `registerMemoryCapability` may also expose `publicArtifacts.listArtifacts(...)`
  for host-managed exports. Companion plugins that enumerate those declared
  artifacts still use `listActiveMemoryPublicArtifacts(...)` from the retained
  `openclaw/plugin-sdk/memory-host-core` facade until a focused public consumer
  API exists; they must not reach into another plugin's private layout.
- A memory runtime that can return session-transcript hits should implement
  `runtime.authorizeSearchHits(...)`. The host calls this hook before raw search
  hits reach caller-visible surfaces and supplies the requesting agent, session
  key, and sandbox state. Return only hits the requester may observe. If the hook
  is absent, OpenClaw fails closed by withholding session-source hits while
  retaining ordinary memory hits. Keep transcript identity and visibility
  policy in the owning memory plugin; callers must not infer authorization from
  paths or duplicate plugin-specific rules.
- `MemoryFlushPlan.model` can pin the flush turn to an exact `provider/model`
  reference, such as `ollama/qwen3:8b`, without inheriting the active fallback
  chain.
- Embedding providers use `api.registerEmbeddingProvider(...)` and
  `contracts.embeddingProviders`; there is no separate memory-only registry.

## Bundled Memory Core workers

Memory Core uses the shared `process-runtime` worker pool for lexical retrieval,
cosine fallback, and immutable chunk preparation. Retrieval retains the search
generation until its readers close; publication, source-hash validation, and
forget operations remain with their existing database owners.

Bundled workers use the private `memory-core-host-engine-knn` facade for
read-only database access and vector primitives, and
`memory-core-host-engine-indexing` for pure chunking, annotations, hashes, and
embedding input limits. These facades avoid loading provider registries or
writable-store initialization into worker threads. They are bundled runtime
contracts, not third-party typed SDK entrypoints.

## Workspace Memory process

When workspace files live on another host, Memory Core's public `worker-api.js`
provides `createGatewayMemoryBinding({ cfg, agentId, agentDir, openWorker, signal })`.
It returns the existing `MemorySearchManager` interface.

```text
Gateway                           Workspace host
embedding provider + credentials  Memory files + native index
         ↑ embedding inputs          │
         └──── embedding vectors ────→│
         ───── search / read ────────→│
         ←──── results ───────────────┘
```

- `openWorker` starts the packaged
  `dist/worker/memory-worker-entry.js <workspace> <stateDir> <agentId>` and returns
  a process with duplex standard streams. SSH can carry those streams; a buffered
  command response alone cannot.
- Before upgrading an existing worker, stop it and run the same entry with
  `--prepare <workspace> <stateDir> <agentId>`. This reuses native database
  maintenance for its private index and refuses to run while another writer
  holds the database. Ordinary search requests do not run maintenance.
- Use a separate worker process per workspace/agent. The host supplies its runtime
  package and transport. Memory Core owns indexing and search; the Gateway retains
  embedding credentials. Close the returned manager when the binding ends.
- This implementation supports workspace Memory files with an explicit embedding
  provider, the native `auto` selection, or keyword-only search (`provider: "none"`), with
  `fallback: "none"`. Set `rememberAcrossConversations: false` and
  leave session Memory disabled. Session sources, extra paths, multimodal input,
  and provider batch jobs are rejected rather than silently ignored.
- A cancelled or timed-out operation closes the binding. Its owner must acquire a
  new manager before further operations. Installing this API does not change the
  default local Memory runtime or configure a remote host automatically.
