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

## Memory files on another host

Register `AgentWorkspaceAccess.memoryFiles` when workspace files live on another
host. Memory Core keeps its existing index, embedding providers, original sessions
and maintenance state on Gateway.

```text
Gateway                         Harness
Memory index + sessions         Memory files
      ─── file operations ────→     │
      ←── bytes + metadata ─────────┘
```

- The native manager uses remote file discovery and reads for indexing and
  `memory_get`. Publication rechecks the Harness source; local stale copies are
  never a fallback for a registered remote workspace.
- `memoryFiles.maintenance` executes existing file mutations beside the files.
  Gateway keeps maintenance decisions and locks; the native file writer preserves
  conflict and publication-outcome handling.
- Memory Core's public `worker-api.js` supplies `serveMemoryFiles`. The packaged
  `dist/worker/memory-worker-entry.js --files <workspace>` consumes one JSON request
  on stdin and returns a JSON result on stdout. Existing buffered command transports
  can invoke it; the worker needs neither an index directory nor embedding credentials.
- The workspace provider owns transport, admitted roots and cancellation. Registering
  this interface does not automatically provision a remote host or wire a paired node.
- The File Transfer workspace adapter connects this client over the paired node's
  `workspace.memory` duplex command. Enable that command explicitly on both sides;
  existing file grants must admit the requested Memory paths. It reuses the same
  file worker and watcher, with the index remaining on Gateway. This adapter
  currently requires canonical paths within the configured workspace; it does not
  grant access to external `extraPaths` or broaden owner document editing.
- `createWorkspaceMemoryFileClient` from `agent-workspace-runtime` adapts that worker
  to `memoryFiles`. Supply the Gateway and remote workspace paths, a lifetime signal,
  a request function (JSON stdin to stdout), and a subscription function (JSON lines).
  The shared client maps paths and preserves native errors, including uncertain write
  outcomes. Providers supply transport and authorization; no Codex process is required.
  This supplies Gateway Memory callers; each harness's tool protocol still determines
  whether its model can call `memory_search` or `memory_get`.
- `--watch-files <workspace>` reuses the native Memory file watcher without creating
  an index. Send one JSON line containing the agent ID and file-watch settings;
  stdout streams `"change"` or `"unavailable"` lines until stdin closes. Only file
  paths, multimodal settings and debounce time cross this interface, not embedding
  provider configuration. Providers need a subscription transport for this mode;
  lost subscriptions must report unavailability so the manager refreshes on search.

### Skills on a paired workspace node

The File Transfer workspace adapter uses `workspace.skills` for native discovery,
instruction/resource reads, change notifications and dependency installation.
Gateway retains the existing installation policy check. Both sides must explicitly
enable the command; file grants must cover source roots and the workspace Skills
directory. A read grant alone does not authorize an installation command.

Workspace paths are mapped to `remoteRoot`. Other configured source directories
must exist at the same paths on the node. Provision bundled/plugin Skills there
and include the native dependency bin directory in the Harness PATH. This adapter
does not yet implement Skill source publication or ClawHub update/removal.
