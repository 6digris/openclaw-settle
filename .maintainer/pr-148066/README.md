# PR148066 fixed missing-task diagnostic

Same fd7a owns this proof-only revision, distinct from the unchanged product head
66a495d350eb87c3af1536ca30e58d3bafb24e95. No #119052 source/branch is changed.

This revision uses the maintained workflow path as a fixed reviewed hosted transport,
with fresh windows-2025 jobs, Node24.20.0, persist-credentials:false and always-upload.
It does not expose diagnostic-command inputs or dispatch an installer.

The six original failure inputs and complete executed import closure are SHA-bound
in source-manifest.json. The original workflow and shared setup are reference-only
immutable Git blobs; no suite/dependency installation/build is run. The actual source
probe and production env projector execute via native type erasure. Only the Node
child_process observer substitutes the script in labeled instrumented cells. The first
baseline script, executable resolver, flags, environment, 5000ms timeout and
windowsHide:false are unchanged. Native registry resolution is retained and recorded.

Runner HOME/USERPROFILE are selected before launching the Node child, within oc-vt-*.
The pinned initializeIsolatedTestEnv function and key arrays execute verbatim after
TypeScript erasure, selecting openclaw-test-home-* and the XDG paths. Non-native self
checks validate imports, extraction, unchanged spawn contract and script transform;
they are not native proof. No Vitest startup/concurrency equivalence is claimed.

Two fresh jobs preserve baseline-first, then reverse relative instrumented/omission
order. The seven-key omission comparator comes from119052 evidence. Those keys are
already supported by this failed source; no absent-key cause is assumed. Native
account/session/PowerShell version and executable hashes are collected after probes
so identity collection does not prewarm the first baseline. PS5.1 is never explicitly
started before that baseline; unknown image/checkout activity stays a limitation.

Every synchronous probe records stdout/stderr (Node's original 1MiB maxBuffer), exit,
signal/error, timestamps, executable, script digests, manager-env key selection and
routing, and bounded cache metadata. Stderr markers label entry, COM, Connect,
GetFolder, GetTask, and caught HRESULT. The outer Node process is bounded at120s and
2MiB separately; it does not relax any5000ms probe budget. Missing assertion failures
remain nonzero outcomes even though collection continues. Green diagnostics never
clear the historic failure or package/native/Apple/product acceptance gates.

Only UUID missing-task reads occur. No task create/install/run/activation, service or
Defender change, live Odin action, network product call, or product source mutation.
Owned temporary homes are removed only after all observed native probe/identity PIDs
are absent; uncertain completion retains the named path for ephemeral-runner teardown.
