---
summary: "One-attempt comparison of on-demand RunsOn and Blacksmith CI runners"
title: "RunsOn on-demand pilot"
read_when:
  - You are evaluating runner speed, setup cost, or warm pools
---

This benchmark changes no production routing. Results and recommendations will
be recorded here after the single PR benchmark run completes. Do not merge this
experimental workflow as a routing change.

## Method

The harness reuses `scripts/ci-provider-bench-phase.py` unchanged from the last
September provider experiment, commit
`bb1124465258037271a6b1dfae20d07b7c8f96d1`, whose workflow was
`.github/workflows/provider-bench-5.yml`. Origin no longer advertises the
`ci-probe/*` branches; the retained local branch supplied the original harness.
There are no provider benchmark report links in the current runner guide.

The newest successful main CI run at selection was
[35542241125](https://github.com/openclaw/openclaw/actions/runs/35542241125),
at `7d1371e25f693185f6f2b1e4a4cd111b5552b4b6`. Its longest large and small
compact jobs supplied the complete encoded group manifests:

| Main job                       | Wall seconds | Test-step seconds |
| ------------------------------ | -----------: | ----------------: |
| `checks-node-compact-large-16` |          849 |               794 |
| `checks-node-compact-small-12` |          794 |               748 |

Each manifest runs on the same PR revision on Blacksmith's 32 label, on-demand
`c8i.4xlarge`, NVMe `c8id.4xlarge`, and `c8id.4xlarge` with a sticky pnpm store.
The sticky pair has distinct cold and warm jobs with the same lineage, Git ref,
and source revision. Main timings explain selection; same-run controls determine
provider comparisons because main and the PR can contain different source.

The full cron config and full Gateway-core config separately run on
`c8i.8xlarge` at 8, 12, and 16 workers, and `c8a.8xlarge` at 8 and 16. The
workflow verifies the effective worker count and file parallelism. Existing
assertions, exclusions, group pins, and timeout policies remain intact. A failure
is a result, with the file and assertion retained; it never triggers a rerun.
Windows runs the complete first Windows CI part on `c8i.4xlarge` with
`windows25-full-x64`, retaining CI's one-worker, serial-project policy.

Node is pinned to `24.19.0`, the actual version recorded by the selected CI
run's `24.x` lane. This replaces the old harness's Node 26. Dependency
installs use the repository's pinned pnpm, frozen lockfile, and native side-effects
cache. All initial stores are cold; the sticky warm jobs alone reuse their cold
cell's store. No shared Actions dependency cache is read or written. Setup-node,
checkout, installation, and test steps remain separately timed. Worker compilation
is owned by the existing shard runner and its reported preparation duration is
identified separately within test-step time.

AWS NVMe images automatically mount instance storage for `/tmp` and
`/home/runner`; the workflow verifies their filesystem devices and physical NVMe models. The sticky variant
keeps `/tmp` on NVMe and places pnpm's store on the snapshot-backed disk. It
verifies the mounted device and requires both an action cache hit and the cold
cell's revision marker before accepting a warm observation.

## Budget and timing definitions

Every AWS label uses `spot=false/retry=false`. The workflow admits one run on PR
opening, only on the named same-repository maintainer branch; report updates do
not run it again. Each cell has a 25-minute job limit. The complete AWS inventory
is two Linux c8i.4xlarge, six c8id.4xlarge, six c8i.8xlarge, four c8a.8xlarge,
and one Windows c8i.4xlarge. Blacksmith supplies two controls. The cold matrix
admits at most three jobs concurrently; Windows is one independent job.

The sum of hourly rates is $24.20072. At 25 minutes plus a ten-minute allocation
and teardown reserve per instance, the planned EC2 ceiling is **$14.11709**,
below the **$15** cap. This is a conservative reservation, not a billing receipt.
Stop the pilot if observed allocation overhead threatens the remaining reserve.
No pool is provisioned. EBS, snapshots, network, and control-plane charges are
separate from the requested EC2 estimate.

Report job wall as GitHub `completed_at - started_at`, and assignment wait as
`started_at - created_at`. Warm jobs additionally depend on the cold matrix;
their dependency wait must not be described as runner assignment latency. Setup
seconds sum the named checkout, runner/cache, Node, machine verification, pnpm,
install, workload-selection, and Windows Defender steps. Test seconds use the observer's elapsed
duration, including runner-owned worker preparation. Windows uses its named test
step duration. Report worker preparation as a component, not an additional wall
charge. AWS compute estimates are `hourly_rate × job_wall_seconds / 3600`;
boot and teardown add billable time outside that comparison.

## Prices and pools

Official AWS us-east-1 on-demand prices, feed published September 18, 2026:

| Instance / OS       | Advertised vCPU | RAM GiB | USD/hour | Two hot instances/day |
| ------------------- | --------------: | ------: | -------: | --------------------: |
| c8i.4xlarge Linux   |              16 |      32 |  0.74968 |              35.98464 |
| c8id.4xlarge Linux  |              16 |      32 |  0.88704 |              42.57792 |
| c8i.8xlarge Linux   |              32 |      64 |  1.49936 |              71.96928 |
| c8a.8xlarge Linux   |              32 |      64 |  1.72432 |              82.76736 |
| c8i.4xlarge Windows |              16 |      32 |  1.48568 |              71.31264 |

Sources: [AWS Linux price feed](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20%28N.%20Virginia%29/Linux/index.json)
and [AWS Windows price feed](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20%28N.%20Virginia%29/Windows/index.json).
Delivered CPU counts come from the jobs, not these specifications. C8a is Zen 5,
with one physical core per vCPU; it does not use the earlier Zen 4 experiment's
custom mitigation-disabled image. The pilot records the kernel command line.

RunsOn reads public-repository runner configuration from the default branch.
[Pools](https://runs-on.com/docs/performance/warm-pools/) additionally belong to
the organization's `.github-private` repository, at `.github/runs-on.yml`.
Therefore this PR documents the following example without installing it:

```yaml
runners:
  r2-c8i-on-demand:
    family: [c8i.4xlarge]
    image: ubuntu24-full-x64
    spot: false
    volume: 80gb:gp3:125mbps:3000iops
pools:
  r2-c8i-hot:
    env: production # Match the deployed stack environment.
    runner: r2-c8i-on-demand
    timezone: UTC
    schedule:
      - name: always
        hot: 2
        stopped: 0
```

Two hot c8i.4xlarge instances cost **$35.98/day compute**, plus approximately
$0.43/day for two 80-GiB baseline gp3 roots and other service charges. Jobs would
select `runs-on=<run-id>/pool=r2-c8i-hot`. A pool trades continuous idle cost for
lower startup latency; this pilot does not measure that benefit.

References: [labels and configuration](https://runs-on.com/docs/runners/labels/),
[NVMe mounts](https://runs-on.com/docs/runners/capabilities/local-storage-nvme/),
[sticky disks](https://runs-on.com/docs/runners/capabilities/sticky-disks/), and
[Windows images](https://runs-on.com/docs/runners/platforms/).

## Validation status before the benchmark

Workflow lint (including shell checks), formatting, the report's MDX check, and
`node scripts/check-changed.mjs` passed. The Python observer is byte-identical to
the September harness. Production `ci.yml` has no diff.

The single local guard run on base `21f3d71a09d4` ran all four requested files:
2,147 cases passed, 12 skipped, and two timed out in 2,663.55 seconds. Both Node
planner files passed. These failures remain explicit proof gaps:

- `ci-workflow-guards.test.ts`: **keeps the preflight manifest import closure
  dependency-free** killed its native Node child after 30.079 seconds, with
  empty output and `status=null` instead of zero. It extracts the unchanged
  preflight script from `ci.yml` and uses a fixed direct-test-path fixture.
- `test-projects.test.ts`: **bounds extensionless prefix probes while excluding
  deleted cached matches** exceeded its 120-second timeout, returning after
  155.101 seconds. It uses a separate six-file Git fixture; the log does not
  identify whether Git setup, selector inventory, or cleanup stalled.

Neither failing path directly consumes the pilot files. Their helpers remain
unchanged through base `21688de06dae`, but their timing root cause is unproven;
no retry, timeout increase, assertion change, or passing result replaces them.
Follow-up belongs with the [tooling lane](https://github.com/openclaw/openclaw/pull/153820),
with the [planner lane](https://github.com/openclaw/openclaw/pull/154057) involved
if the preflight child stalls in planning. Neither linked change is claimed to
fix these exact failures. This experiment is not a merge candidate.
