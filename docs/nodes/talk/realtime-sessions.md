---
summary: "Voice selection from chat, realtime delegation, steering, transcripts, and browser Talk behavior"
read_when:
  - Wiring a realtime Talk client or a Gateway-controlled call
  - Changing voice selection, steering, or transcript handling
  - Debugging browser Talk microphone or transcription errors
title: "Talk realtime sessions and delegation"
sidebarTitle: "Realtime sessions"
---

## Choose a Talk voice from chat

During an active browser, iOS, or Android realtime Talk call, ask the assistant
to list the available voices or switch to one. Browser Talk also offers a voice
picker beside the call controls. The `talk_voice`
tool lists the current provider, model, voice,
and supported voice IDs for the call in the current conversation. Setting a
voice reconnects that call while preserving its chat and captions. The replacement
waits for finalized speech to be saved and receives bounded conversation history,
including speech finalized while the old connection closes. Accepted agent work
keeps running during this handoff. The assistant
reports success only after the replacement call is ready; unsupported changes or
connection failures return an error. **Settings → Talk** sets the voice default
for future calls. In a Discord realtime voice channel, ask the agent to list or
change voices using the same tool. The change applies to that connected room,
including subsequent speakers, and leaves its saved Discord voice configuration
unchanged. The Discord connection and agent conversation remain active while the
provider connection is replaced.

iOS supports switching in WebRTC and Gateway-relay calls. Android supports it
in Gateway-relay calls using its supported realtime models. Native speech and
TTS fallback calls retain their existing voice settings. Switching uses the
current Gateway connection and conversation; ending the call or changing
Gateways cancels a pending switch.

Mobile apps enable switching when the connected Gateway advertises voice
selection support. Calls still start on older Gateways, but switching remains
unavailable until the Gateway is updated.

For Talk TTS playback, after setting `talk.provider` and the matching `talk.providers.<provider>` configuration, use `/voice status` to inspect the active provider and voice, `/voice list [limit]` to list its available voices, and `/voice set <voiceId|name>` to save a provider-scoped selection. Discord exposes the same command natively as `/talkvoice`.

Status and list are read-only. Setting a voice requires the message-channel owner or a Gateway client with `operator.admin`. Configuration, provider lookup, unknown-voice, and permission failures are returned visibly in chat. A masked API-key value in `/voice status` describes config only; it does not verify credential availability.

Client-owned realtime Talk normally forwards provider tool calls through `talk.client.toolCall` instead of calling `chat.send` directly. GPT-Live WebRTC sessions delegate on a Gateway-owned sideband, and the Gateway binds each delegation to the browser or Gateway-relay Talk session that owns it. Backend WebSocket bridges use the normal relay consult path. While a realtime consult is active, clients can call `talk.client.steer` or `talk.session.steer` to classify spoken input as `status`, `steer`, `cancel`, or `followup`; this includes GPT-Live delegations. Accepted steering queues into the active embedded run; rejected steering returns a reason such as `no_active_run`, `not_streaming`, or `compacting`. A newer GPT-Live spoken task also supersedes the running delegation.

Thin audio clients can request `gateway-control-v1` in
`talk.client.create.capabilities`. OpenAI GA Realtime requires a Platform API
key for this mode. The released GPT-Live route keeps its existing ChatGPT OAuth
or Platform authentication; unlisted routes require Platform authentication.
Requesting Gateway control does not switch the selected model.

Success returns `clientControl: { owner: "gateway" }`, a 60-second single-use
`clientSecret`, and the relative offer URL `/plugins/openai/realtime/calls`.
The client posts an audio-only SDP offer and opens no provider data channel.
The Gateway attaches the provider's server sideband and owns tools or native
agent delegation, transcripts, steering, cancellation, and call cleanup while
media continues directly between the client and OpenAI. Negotiated sessions
share a two-session limit per client connection, including pending offers.
Unsupported combinations, including GA with OAuth only, fail visibly instead
of falling back to client-owned control. Existing browser clients omit this
capability and keep their data channel and client transcript reporting.

In Gateway-controlled native calls and native Gateway relays, the provider's
delegation starts each host action. Final speech transcripts are saved to history;
they neither trigger actions nor repeat a delegation's action. Status keeps the
current task running, cancellation stops it, and redirects or follow-ups target
that call's active work. When the call has no active task, status and cancellation
return a spoken no-active-run response, even if another call on the same connection
and agent session has work in progress. Ordinary requests such as “Check the
weather” still start tasks while idle. Genuine new tasks retain the native
delegation replacement behavior.

These calls disable provider-generated delegation acknowledgments at creation.
OpenClaw sends one neutral receipt when it launches a real task; status and
cancellation requests wait for the host result instead, without waiting for final
speech transcription. A full control queue produces a spoken refusal; retry after
the pending controls finish. A task receipt is not confirmation that a model or
tool has started, and submitting a spoken result is not proof of audible delivery.

Closing a native transport fences new delegations and late provider delivery;
already accepted agent work retains its own cancellation lifetime. Spoken run
cancellation is separate from ending the audio connection. Gateway-controlled
native sessions acknowledge cancellation without speaking the canceled task's
partial answer, empty-result fallback, or failed-task retry prompt. Timeouts
remain failures rather than being silently treated as cancellations.

Finalized realtime user and assistant utterances are always appended live to the active agent session, so later chat and voice turns share one history. Client-owned transports report their finalized transcripts with stable entry ids; Gateway relay and Gateway-controlled WebRTC sessions append the same events server-side. Provider sessions also receive the bounded realtime profile context used by Discord voice.

Speech finalized while an accepted consult is starting remains visible in history
and does not prevent the agent from adopting that consult's recorded input.
Completed agent answers and newly admitted tasks still close the older input;
speech records do not reopen it.

Gateway-controlled native WebRTC calls receive shared-session history as quoted
historical background in their instructions, not as the new call's own user or
assistant messages. This background can include prior calls and backing-agent
answers; it does not establish the current call's live task state. It retains
the newest history within 16 entries, 800 characters per entry, and 8,000 UTF-8
bytes including labels and quoting. This changes neither saved transcripts nor
chat display. Native calls without negotiated host input control and direct
WebSocket conversation seeds keep their existing representation.

Generated agent-consult prompts are internal input, not spoken user turns. New
consult records are hidden from chat and excluded from later model context, while
the active consult still receives the full question, context, and response style.
Raw archives and [session exports](/tools/slash-commands) remain lossless. Existing
consult records without the exclusion flag are not rewritten and remain eligible
for model context.

Chat-backed Talk stores the spoken answer without a second copy of the
successful consult answer in visible history; the internal answer remains in the
raw transcript and model context. Tool activity, progress, errors, and interrupted
replies retain their existing visibility.

Direct provider-owned consultations keep their own final answer visible in Chat.
Accepted work can outlive a closed or replaced audio connection, so a spoken
replacement is not guaranteed. If speech also arrives, both records may be visible;
OpenClaw preserves the answer rather than guessing that the spoken text replaces it.

OpenAI GA browser Talk keeps provider conversation order even when an assistant
reply finishes before the user's transcription or item announcements arrive out
of order. Text streams immediately in the call view; late predecessor metadata
places it beside the correct reply. Stopping a call drains finalized speech,
skips unfinished transcriptions, and records a browser console warning for
missing transcriptions or unresolved conversation links.

Google Live saves complete utterances during the call, including Gemini 3.1
transcriptions that omit an explicit transcription-finished flag. Partial text
stays provisional until the provider's completion boundary.

Voice-originated consult runs require a new, exact spoken confirmation before high-impact actions such as sending messages, controlling nodes, browser/computer actions, service changes, destructive shell commands, or publication. The gate applies to runs started through `talk.client.toolCall`, the Gateway relay, and GPT-Live sideband delegations. The confirmation applies only to the canonical final execution arguments and is consumed once; if a policy or hook rewrites the approved action, OpenClaw blocks it until the rewritten action is confirmed. Unrelated concurrent runs remain unaffected. When a call closes, OpenClaw can send a compact **Voice call changes** digest for mutating tools to the session's last non-WebChat delivery target.

### Preauthorize an exact installed-app launch

An operator can configure `talk.realtime.appLaunchPolicies` to satisfy only the
Talk confirmation requirement for a narrowly scoped installed-app launch. It is
empty by default. Each policy names an agent, an authenticated originating device,
a separately scoped target paired-node identity, an installed app and its executable
revision, and an absolute expiry in Unix milliseconds. No wildcards or shell
commands are accepted.

The first supported operation is `nodes` with `action: "app_launch"` on a Linux
TypeScript node host. Enable installed-app sharing on that node, approve its
updated pairing declaration, and explicitly allow `device.apps.launch` in the
Gateway node-command policy. Use `nodes` with `action: "app_list"`, the full node
ID, and an optional `query` to inspect eligible applications without a mutation
confirmation. The node serves this read through `device.apps`. Inspect the results
and copy the exact `appId` and `appRevision`. Display names and Computer Use's
execution-local app references are not policy identities.

For example, this is the policy-list shape; replace every example identity,
revision, and expiry with the intended values:

```json5
{
  talk: {
    realtime: {
      appLaunchPolicies: [
        {
          id: "calculator",
          agentId: "main",
          originatingDeviceId: "paired-voice-client-id",
          nodeId: "paired-linux-desktop-id",
          appId: "linux-desktop:org.gnome.Calculator.desktop",
          appRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          expiresAtMs: 1893456000000,
        },
      ],
    },
  },
}
```

Use an authenticated operator's config editor or `config.patch`/
`config.apply` RPC with the current base hash. Read the list with `config.get`.
To revoke a policy, remove it with explicit array replacement intent
(`replacePaths: ["talk.realtime.appLaunchPolicies"]`), or replace the full config.
A successful policy-write acknowledgment means the active Gateway applied the
change. Reload-disabled or restart-requiring mixed edits are refused by immediate
application preflight; apply unrelated settings separately. Offline file/CLI edits
are saved configuration, not proof of active revocation until the Gateway applies
them. Existing privileged filesystem access remains part of the installation's
trust boundary.

**Configuration and rollback compatibility:** The policy list is optional. Existing
configs with the field absent, and configs with an empty list, create no reusable
grants and retain ordinary Talk confirmation and continuation behavior. Loading
them does not backfill a policy. This option needs no feature-specific Doctor
transform: it does not rename or retire an existing config key.

The policy-use identifier on a voice effect is optional diagnostic metadata in
the existing version-1 voice record, not persisted execution authority. Existing
records without it remain readable. Closing and reopening the database does not
restore a device grant; each new consult needs fresh authenticated ingress. This
feature adds no SQL table, column, schema-version bump, or retention change.

Loading an older config is not a guarantee of downgrade compatibility. An older build
whose strict realtime schema lacks `appLaunchPolicies` rejects that key, **even
when its value is `[]`**. Before such a downgrade, use the compatible build to
revoke policies, confirm active application, and drain in-flight launches; then remove the new key entirely
or restore an appropriate pre-feature configuration backup. Keep any policy
backup private and restore it only on a supporting build after revalidating its
identities, revision, and expiry. This feature-local statement does not waive
other database, updater, plugin, or rollback compatibility requirements.

Model-originated config proposals cannot obtain these grants from Full Access
alone: the system-agent owner requires explicit approval of the exact proposal.
Delegation text, transcripts, and provider/plugin prompts never mint grants.

The originating client must authenticate with its signed, paired-device token.
A signed device identity combined with the shared Gateway token is **not**
paired-device-token authentication. A newly paired client may need to reconnect
after receiving its device token; verify the actual handshake mode rather than
inferring it from pairing or a client configuration screenshot. Shared-token
clients and unknown origins keep ordinary confirmation.

App-launch policies do not add a new restriction to ordinary Talk continuation.
Each consult receives only its own authenticated RPC or provider-transport origin;
resuming a call from another client does not inherit a previous client's reusable
grant. Stored call IDs and old persisted records never restore that authority.
Already admitted consults retain their own device-revocation hold after hangup
or transport resume; completion releases that hold. The same owner handles Browser Talk, native thin
clients using Gateway control, Gateway relay, and native sideband delegation.

Launches accept only an installed desktop-entry identity, its revision, and the
explicit node. The initial Linux implementation supports top-level XDG application
entries that directly select a native ELF executable with no arguments, including
a single correctly quoted executable path. Entries
requiring shell/script launchers, field codes, terminal execution, custom working
directories, or command-line arguments are not eligible. Other applications keep
their existing launch/confirmation paths. The revision binds the canonical entry/executable paths and executable identity
metadata, not cosmetic desktop-entry text. Changes to the selected executable or
its installation invalidate that binding; inspect and explicitly authorize the
new revision rather than broadening the match.

The Gateway rechecks current policy and originating-device authority after hook,
node-policy, and readiness waits. After the node has completed its independent
execution-policy preparation, it requests one final invocation-bound launch permit.
The node rechecks its local permission and app revision immediately before a
zero-argument, non-shell spawn. Revocation stops operations that have not received
that final permit; it does not undo an already admitted launch. A short permit
round-trip budget prevents a delayed permit from executing later.

Tool permissions, node allowlists, pairing, plugin denials, and ordinary node
execution approvals still apply. Nodes configured with `ask: "always"` return an
approval-required denial for this constrained operation; this operation does not
open or bypass the ordinary interactive execution-approval exchange. Use an
approval-supported launch path when that exchange is required.

When policies are configured, Nodes remains directly available under code mode so
app discovery and launch do not need an outer arbitrary `exec` call. Generic code
execution and unrelated Nodes actions keep their existing confirmation rules.
A policy for one app does not authorize another
app, node, client, agent, shell command, messaging, publication, or administration.
Talk's existing effect record retains only the matching policy ID, not executable
arguments. A launch acknowledgment reports process dispatch, not proof that a GUI
window appeared.

After a confirmation prompt, say **yes** to confirm the pending action or **no**
to cancel it. Each confirmation permits one matching action; another action may
need another confirmation. Native GPT-Live calls use the finalized user speech
recorded for that call, so generated delegation text cannot supply confirmation.
When a native consult is blocked by this gate, Talk returns a specific retry
prompt. If the pending confirmation expires or is cleared before the result,
Talk reports that the action did not run and asks for a fresh request.

Transcription-only Talk emits the same Talk event envelope as realtime and STT/TTS sessions, but uses `mode: "transcription"` and `brain: "none"`. All Talk sessions broadcast events on the `talk.event` channel; clients subscribe to it for partial/final transcript updates (`transcript.delta`/`transcript.done`) and other session telemetry.

Transcription providers can advertise their model choices in `talk.catalog.transcription.providers[].models`. Pass `model` to `talk.session.create` to override the configured transcription model for that session. Omitting it keeps the provider configuration, then the matching `agents.defaults.voiceModel`, then the provider's own default.

Browser Video Talk is available for OpenAI Realtime WebRTC and Google Live
provider-WebSocket sessions. OpenAI gets a single bounded JPEG when
`describe_view` asks for visual context; it does not receive a continuous
camera track. Google Live receives bounded JPEG frames directly from the
browser at up to one frame per second, while `describe_view` reports the
camera-stream state. In both cases, camera frames bypass the Gateway, and
stopping Talk releases the camera and microphone tracks.

Browser Talk shows startup progress while preparing the session, waiting for
microphone access, and connecting. Talk and dictation show microphone guidance
while the browser's capture request is pending: bring the tab to the foreground
and allow access if prompted. The browser can keep an unanswered permission
request pending. In Talk, **Stop voice input** cancels startup and releases any
microphone stream granted after cancellation.

Browser Talk acquires the microphone before creating the provider session, so
time spent granting permission does not consume a short-lived connection token.
If session creation fails, Talk releases the microphone before reporting the error.

If OpenAI cannot transcribe an utterance, browser Talk shows the provider's error
without ending the call or inventing a transcript. You can speak again; audio
responses continue independently of input transcription.

If the microphone disconnects or its permission is revoked, browser Talk ends
the call and shows an error. Choose an available **Microphone input**, restore
permission if needed, and start Talk again. An unexpected GPT-Live connection
loss also ends the call with an error; automatic reconnection is not supported.
