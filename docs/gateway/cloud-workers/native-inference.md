---
summary: "Runtime-local inference on an externally managed paired worker host"
title: "Worker-local inference"
read_when:
  - Hosting a dedicated native worker on an externally managed machine
  - Keeping model credentials on a paired node instead of the Gateway
---

# Worker-local inference

Worker turns normally proxy model requests through the Gateway. A configured
paired-device profile can instead select **runtime-local inference**, using the
same admission, turn claims, local coding tools, transcript commits, live events,
and node supervisor. There is no separate runtime server or network protocol.

Your platform owns the host, container, or Pod and its revision. The built-in
`device` provider adopts a paired node and releases logical leases; it does not
create, replace, or delete the platform workload. The supervisor still owns its
worker children and managed workspaces. Use a dedicated node account per trust
boundary. Workspace grants are not an operating-system sandbox: code running as
that account has its normal filesystem and process access.

## Provision the node

Install matching Gateway and node builds and pair the node normally. Keep provider
credentials in the node service's externally provisioned startup environment, not
Gateway configuration or profile settings. In the **node's** configuration:

```json5
{
  nodeHost: {
    workerRuns: {
      enabled: true,
      capacity: 1,
      isolation: "none",
      nativeInferenceConfig: "/etc/openclaw/worker-inference.json",
    },
  },
}
```

The external platform may run the node inside a container. OpenClaw's additional
nested-container worker mode is not supported for local inference. Make the
registry file readable only by the service account. For example, with node state
rooted at `/srv/worker-state`:

```json validate=false
{
  "models": [
    {
      "provider": "openai",
      "id": "worker-model",
      "api": "openai-completions",
      "baseUrl": "https://model.example.test/v1",
      "contextWindow": 32768,
      "maxTokens": 4096,
      "reasoning": true,
      "thinkingLevelMap": { "low": "low", "high": "high" },
      "cost": { "input": 2, "output": 8, "cacheRead": 1, "cacheWrite": 2 },
      "apiKeyEnv": "NATIVE_MODEL_API_KEY"
    }
  ],
  "workspaces": [
    {
      "id": "assistant",
      "path": "/srv/worker-state/node-host",
      "scope": "subdirectories",
      "models": ["openai/worker-model"]
    }
  ]
}
```

Replace the endpoint and model metadata with your provider's supported adapter and
values. Prices are per million tokens. `apiKeyEnv` names a variable already
provisioned into the node service; it never contains the credential itself.
Optional `headers` are node-local startup values too. Known credential-bearing
header names are protected automatically. List nonstandard authentication header
names in the model's `sensitiveHeaderNames` array (case-insensitive); other headers
remain ordinary metadata. For example, `"sensitiveHeaderNames": ["X-Session"]`
classifies a configured `X-Session` value without classifying a routing header.
No model configuration is
loaded from the workspace, a turn request, Gateway auth profiles, or dotenv files.

A workspace grant's `id` is the exact agent ID. Omitted `scope` means an exact
workspace path. Explicit `subdirectories` allows normal dispatch to create
generated workspaces below a stable operator-selected root; you do not predict
environment/session directory names. Both node and worker check canonical
containment, and the runtime pins directory identity during the turn. Use a
narrower existing root when possible. Optional `sessionId` restricts a grant to
one known session incarnation. List `models` explicitly: each child receives only
its agent's grant and permitted model credentials.

The supervisor snapshots the file and named credentials at startup. Rotation
requires controlled node/worker replacement through your platform lifecycle; it
does not mutate a running registry. The private startup carrier is removed before
tools execute. Workspace preparation, repository setup, and unrelated proxied
workers do not inherit it.

## Select the placement on the Gateway

Configure an explicit device profile with the paired device ID:

```json5
{
  agents: {
    defaults: {
      model: { primary: "openai/worker-model" },
      models: { "openai/worker-model": {} },
    },
    entries: { assistant: {} },
  },
  cloudWorkers: {
    profiles: {
      "dedicated-native": {
        provider: "device",
        settings: {
          device: "PAIRED_DEVICE_ID",
          inference: "runtime-local",
        },
      },
    },
  },
}
```

Use **New Session → Cloud → dedicated-native**, the authorized agent, and **New
workspace** or a selected repository. Existing sessions use normal dispatch/move
controls. Select the configured profile, not the ordinary paired-device picker:
ordinary device placement remains proxied. The Gateway still authorizes the
model, tools, session, placement, and current run.

The launch carries a feature-gated inference choice and the existing model
reference, not model endpoints, headers, or provider credentials. Missing local
configuration, denied grants, incompatible workers, and provider errors fail
closed. The worker and Gateway both reject proxy fallback for local turns.
Omitting `settings.inference`, or setting it to `gateway`, preserves the default.

## Behavior and limits

- Coding tools execute in the worker. Existing grants and permission modes apply.
  Interactive exec approvals and worker LLM-review approval transport remain
  unsupported; approval-required execution is denied, not auto-approved.
- The local registry owns real model API, input capabilities, context window,
  output-token limit, prices, and thinking support. Unsupported thinking and
  conflicting token-budget overrides are rejected. The existing worker replay
  projection preserves supported provider replay in canonical Gateway transcripts.
- Automatic compaction and retry remain disabled by the existing worker runtime.
  Local inference does not add an alternative compaction path.
- Azure adapters requiring ambient endpoint configuration and ambient Vertex ADC
  marker credentials are rejected. Provider plugin loading is not added.
- Cancellation and replacement use existing worker fencing and terminate local
  model requests. The Gateway retains transcripts, acknowledgments, and terminal
  settlement.
- The runtime guards literal credential reflection, including stream fragments
  and normalized values. This is not general data-loss prevention or an isolation
  boundary against code running as the node's operating-system user.

## Verification

Focused compiled-process proof uses an isolated real Gateway service, SQLite
transcripts, a spawned worker, and a loopback HTTP model fixture:

```bash
node scripts/run-vitest.mjs run src/worker/native-worker.integration.test.ts
```

It covers local provider calls and tools, transcript persistence, denial,
cancellation, replacement, and the proxied sibling. This is not a paid-provider
or live platform deployment test. The test runner compiles the source fixture
through its owned runtime graph; it does not use an ad hoc TS loader in the child.
To verify the actual deploy bundle, installer, and node supervisor:

```bash
pnpm build
OPENCLAW_TEST_NATIVE_WORKER_BUNDLE=1 node scripts/run-vitest.mjs run src/worker/native-worker.bundle.integration.test.ts
```

The opt-in lane uses the supported prepackaged, SHA-addressed archive path and
checks the real installer, prewarm, supervisor, and worker; it does not exercise
archive acquisition over HTTP. It fails if matching build artifacts are missing. Follow normal [node and worker setup](/gateway/cloud-workers/setup-and-bundle-installation)
for installation; this feature does not deploy or restart services automatically.
